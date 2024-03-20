import EventEmitter from "events";
import Axios, {AxiosResponse, AxiosRequestHeaders} from "axios";
import stream from "stream";
import {Buffer} from "buffer";
import TypedEventEmitter from "../typed-emitter";
import {FragmenterError, FragmenterErrorCode, UnrecoverableErrors} from "../errors";
import {FragmenterContext} from "../core";

export interface StreamDownloaderEvents {
    'progress': (loaded: number) => void,
    'error': (error: any) => void,
}

export interface StreamDownloaderResult {
    buffers: Buffer[],
    bytesWritten: number,
    error?: FragmenterError
}

export class StreamDownloader extends (EventEmitter as new() => TypedEventEmitter<StreamDownloaderEvents>) {
    constructor(
        private readonly ctx: FragmenterContext,
        private readonly downloadUrl: string,
    ) {
        super();
    }

    async downloadFrom(startIndex: number): Promise<StreamDownloaderResult> {
        const ret: StreamDownloaderResult = {
            buffers: [],
            bytesWritten: 0,
            error: undefined
        };

        this.ctx.logTrace(`[StreamDownloader] streaming file bytes (${startIndex}-) at '${this.downloadUrl}'`);

        let downloadStream: AxiosResponse<stream.Readable>;

        try {
            downloadStream = await this.getReadStream(startIndex, this.downloadUrl);
        } catch (e) {
            this.emit('error', e);

            this.ctx.logError('[StreamDownloader] File streaming could not be started:', e.message);

            return {
                buffers: [],
                bytesWritten: 0,
                error: FragmenterError.createFromError(e)
            };
        }

        try {
            await new Promise((resolve, reject) => {
                downloadStream.data.on('close', () => {
                    if (this.ctx.signal.aborted) {
                        reject(FragmenterError.create(FragmenterErrorCode.UserAborted, 'Abort Signal triggered'));
                    } else {
                        resolve(undefined);
                    }
                });

                downloadStream.data.on('error', (e) => {
                    this.ctx.logError('[StreamDownloader] download stream interrupted:', e.message);

                    reject(FragmenterError.createFromError(e));
                });
            });
        } catch (e) {
            ret.error = e;

            if (FragmenterError.isFragmenterError(e) && UnrecoverableErrors.includes(e.code)) {
                this.ctx.logError(`[StreamDownloader] stream download error is unrecoverable (${FragmenterErrorCode[e.code]}) - not trying to resume the download`);

                this.ctx.unrecoverableErrorEncountered = true;
            }
        } finally {
            downloadStream.data.destroy();
        }

        return ret;
    }

    private async getReadStream(startIndex: number, url: string): Promise<AxiosResponse<stream.Readable>> {
        // @ts-ignore
        const headers: AxiosRequestHeaders = {};

        if (this.ctx.options.userAgent !== undefined) {
            headers['User-Agent'] = this.ctx.options.userAgent
        }

        if (startIndex !== 0) {
            headers.Range = `bytes=${startIndex}-`;
        }

        const response = await Axios.get(url, {
            headers, responseType: 'stream', signal: this.ctx.signal
        });

        this.ctx.signal.addEventListener('abort', () =>{
            response.data.destroy();
        });

        return response;
    }

}