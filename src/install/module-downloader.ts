/* eslint-disable no-useless-constructor */

import EventEmitter from "events";
import {DistributionModule} from "../types";
import TypedEventEmitter from "../typed-emitter";
import {FragmenterContext, FragmenterOperation} from "../core";
import Axios from "axios";
import urljoin from "url-join";
import {FileDownloader} from "./file-downloader";
import path from "path";
import {promisify} from "util";
import fs from "fs-extra";
import {FragmenterError} from "../errors";

export interface ModuleDownloaderProgress {
    loaded: number,
    total: number,
    partLoaded: number,
    partTotal: number,
    partIndex: number,
    numParts: number,
}

export interface ModuleDownloaderEvents {
    'progress': (progress: ModuleDownloaderProgress) => void,
    'downloadInterrupted': (fromUserAction: boolean) => void,
    'error': (error: Error) => void
}

export class ModuleDownloader extends (EventEmitter as new() => TypedEventEmitter<ModuleDownloaderEvents>) {
    constructor(
        private readonly ctx: FragmenterContext,
        private readonly baseUrl: string,
        private readonly module: DistributionModule,
        private readonly moduleIndex: number,
        private readonly retryCount: number,
        private readonly fullModuleHash: string
    ) {
        super();
    }

    private probedModuleFileSize: number;

    async startDownload(destDir: string): Promise<boolean> {

        this.ctx.currentPhase = {
            op: FragmenterOperation.InstallModuleDownload,
            module: this.module,
            moduleIndex: this.moduleIndex
        };

        this.probedModuleFileSize = await this.probeModuleCompleteFileSize();

        const moduleSplitFileCount = this.module.splitFileCount;

        if (Number.isFinite(moduleSplitFileCount) && moduleSplitFileCount > 0) {
            this.ctx.logInfo(`[ModuleDownloader] Downloading module file '${this.module.name}' in ${moduleSplitFileCount} parts`);

            await this.downloadModuleFileParts(destDir);

            this.ctx.logTrace(`[ModuleDownloader] Done downloading module file '${this.module.name}'`);

            return this.mergeModuleFileParts(destDir);
        } else {
            this.ctx.logInfo(`[ModuleDownloader] Downloading module file '${this.module.name}'`);

            const ret = await this.downloadModuleFile(destDir);

            this.ctx.logTrace(`[ModuleDownloader] Done downloading module file '${this.module.name}'`);

            return ret;
        }
    }

    private async probeModuleCompleteFileSize() {
        const fileName = `${this.module.name}.zip`;

        const url = urljoin(this.baseUrl, fileName);

        let headers;
        try {
            headers = (await Axios.head(url)).headers;

            const length = parseInt(headers['content-length']);

            if (Number.isFinite(length)) {
                return length;
            }
        } catch (e) {
            this.ctx.logWarn(`[ModuleDownloader] Could not probe module complete file size: ${e.message}`);

            // TODO register error in context
        }

        return undefined;
    }

    private async downloadModuleFile(destDir: string): Promise<boolean> {
        const fileName = `${this.module.name}.zip`;

        const fileUrl = urljoin(this.baseUrl, fileName);

        let url = `${fileUrl}?moduleHash=${this.module.hash.substring(0, 8)}&fullHash=${this.fullModuleHash.substring(0, 8)}`;

        if (this.retryCount) {
            url += `&retry=${this.retryCount}`;
        }

        const downloader = new FileDownloader(this.ctx, url, this.retryCount > 0);

        // eslint-disable-next-line no-loop-func
        downloader.on('progress', (loaded) => {
            this.emit("progress", {
                loaded,
                total: this.probedModuleFileSize ?? this.module.completeFileSize,
                partLoaded: undefined,
                partTotal: undefined,
                partIndex: undefined,
                numParts: undefined,
            });
        });

        downloader.on('downloadInterrupted', (fromUserAction) => {
            this.emit('downloadInterrupted', fromUserAction);
        });

        const filePath = path.join(destDir, `${this.module.name}.zip`);

        try {
            const {error} = await downloader.download(filePath);

            if (error) {
                throw error;
            }

            return true
        } catch (e) {
            this.ctx.logError(`[ModuleDownloader] module download at '${url}' failed`, e.message);

            if (this.ctx.unrecoverableErrorEncountered) {
                this.ctx.logInfo('[ModuleDownloader] file download error was unrecoverable - abandoning module download');
            }

            try {
                await fs.access(filePath);
                await promisify(fs.rm)(filePath)
            } catch (e) {
                //noop
            }

            throw e;
        }
    }

    private async downloadModuleFileParts(destDir: string): Promise<boolean> {
        const numParts = this.module.splitFileCount;

        let totalLoaded = 0;

        for (let i = 0; i < numParts; i++) {
            this.ctx.logTrace(`[ModuleDownloader] downloading module part #${i + 1}`);

            const partIndexString = (i + 1).toString()
                .padStart(numParts.toString().length, '0');
            const partFileSuffix = `sf-part${partIndexString}`;
            const partFileName = `${this.module.name}.zip.${partFileSuffix}`;
            const partUrl = urljoin(this.baseUrl, partFileName);

            let url = `${partUrl}?moduleHash=${this.module.hash.substring(0, 8)}&fullHash=${this.fullModuleHash.substring(0, 8)}&partIndex=${i}`;

            if (this.retryCount) {
                url += `&retry=${this.retryCount}`;
            }

            const partDownloader = new FileDownloader(this.ctx, url, this.retryCount > 0);

            // eslint-disable-next-line no-loop-func
            partDownloader.on('progress', (loaded, total) => {
                this.emit('progress', {
                    loaded: totalLoaded + loaded,
                    total: this.probedModuleFileSize ?? this.module.completeFileSize,
                    partLoaded: loaded,
                    partTotal: total,
                    partIndex: i,
                    numParts: this.module.splitFileCount,
                });
            });

            partDownloader.on('error', (error) => {
                this.emit('error', error);
            })

            const filePath = path.join(destDir, `${this.module.name}.zip.fg-tmp${partIndexString}`);

            try {
                const {bytesDownloaded, error} = await partDownloader.download(filePath);

                if (error) {
                    throw error;
                }

                totalLoaded += bytesDownloaded;
            } catch (e) {
                this.ctx.logError(`[ModuleDownloader] part download at '${url}' failed`, e.message);

                if (this.ctx.unrecoverableErrorEncountered) {
                    this.ctx.logError('[ModuleDownloader] file download error was unrecoverable - abandoning module download');
                }

                try {
                    await promisify(fs.rm)(filePath);
                } catch (e) {
                    // noop
                }

                throw e;
            }
        }

        return true;
    }

    private async mergeModuleFileParts(destDir: string): Promise<boolean> {
        this.ctx.logInfo(`[Module Downloader] Merging ${this.module.splitFileCount} file parts for module '${this.module.name}'`);

        const numParts = this.module.splitFileCount;

        for (let i = 0; i < numParts; i++) {
            const completedModuleFileWrittenStream = fs.createWriteStream(path.join(destDir, `${this.module.name}.zip`), {flags: 'a'});

            const partIndexString = (i + 1).toString()
                .padStart(numParts.toString().length, '0');

            const filePath = path.join(destDir, `${this.module.name}.zip.fg-tmp${partIndexString}`);

            try {
                await fs.access(filePath);
            } catch (e) {
                this.ctx.logError(`[ModuleDownloader] Could not find module file part #${i + 1} at '${filePath}' - it must not have been downloaded correctly`);
                return false;
            }

            const partFileReadStream = fs.createReadStream(filePath);

            try {
                await new Promise((resolve, reject) => {
                    completedModuleFileWrittenStream.on('close', resolve);

                    partFileReadStream.on('error', (e) => reject(FragmenterError.createFromError(e)));

                    completedModuleFileWrittenStream.on('error', (e) => reject(FragmenterError.createFromError(e)));

                    partFileReadStream.pipe(completedModuleFileWrittenStream);
                });
            } catch (e) {
                this.ctx.logError('[ModuleDownloader] merge of file failed:', e.message);

                throw e;
            } finally {
                partFileReadStream.destroy();
                completedModuleFileWrittenStream.destroy();
            }

            this.ctx.logTrace(`[ModuleDownloader] Merged file part #${i + 1}`);

            await promisify(fs.rm)(filePath);
        }

        return true;
    }
}