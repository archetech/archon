import { imageSize } from 'image-size';
import { fileTypeFromBuffer } from 'file-type';
import {
    InvalidParameterError,
} from '@didcid/common/errors';
import {
    GatekeeperInterface,
    ResolveDIDOptions,
} from '@didcid/gatekeeper/types';
import {
    CreateAssetOptions,
    FileAsset,
    FileAssetOptions,
    ImageAsset,
} from '@didcid/keymaster/types';

// Type for constructors
type Constructor<T = {}> = new (...args: any[]) => T;

// Interface describing the base class requirements for DocumentMixin
export interface DocumentMixinRequirements {
    gatekeeper: GatekeeperInterface;
    createAsset(data: unknown, options?: CreateAssetOptions): Promise<string>;
    resolveAsset(did: string, options?: ResolveDIDOptions): Promise<any>;
    updateAsset(did: string, data: Record<string, unknown>): Promise<boolean>;
}

export function DocumentMixin<TBase extends Constructor<DocumentMixinRequirements>>(Base: TBase) {
    return class DocumentImpl extends Base {
        async generateImageAsset(buffer: Buffer): Promise<ImageAsset> {
            let metadata;

            try {
                metadata = imageSize(buffer);
            }
            catch (error) {
                throw new InvalidParameterError('buffer');
            }

            const cid = await this.gatekeeper.addData(buffer);
            const image: ImageAsset = {
                cid,
                bytes: buffer.length,
                ...metadata,
                type: `image/${metadata.type}`
            };

            return image;
        }

        async createImage(
            buffer: Buffer,
            options: CreateAssetOptions = {}
        ): Promise<string> {
            const image = await this.generateImageAsset(buffer);

            return this.createAsset({ image }, options);
        }

        async updateImage(
            id: string,
            buffer: Buffer
        ): Promise<boolean> {
            const image = await this.generateImageAsset(buffer);

            return this.updateAsset(id, { image });
        }

        async getImage(id: string): Promise<ImageAsset | null> {
            const asset = await this.resolveAsset(id) as { image?: ImageAsset };
            const image = asset.image;

            if (!image || !image.cid) {
                return null;
            }

            const buffer = await this.gatekeeper.getData(image.cid);
            if (buffer) {
                image.data = buffer;
            }

            return image;
        }

        async testImage(id: string): Promise<boolean> {
            try {
                const image = await this.getImage(id);
                return image !== null;
            }
            catch (error) {
                return false;
            }
        }

        async getMimeType(buffer: Buffer): Promise<string> {
            // Try magic number detection
            const result = await fileTypeFromBuffer(buffer);
            if (result) return result.mime;

            // Convert to UTF-8 string if decodable
            const text = buffer.toString('utf8');

            // Check for JSON
            try {
                JSON.parse(text);
                return 'application/json';
            } catch { }

            // Default to plain text if printable ASCII
            // eslint-disable-next-line
            if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(text.replace(/\n/g, ''))) {
                return 'text/plain';
            }

            // Fallback
            return 'application/octet-stream';
        }

        async generateFileAsset(
            filename: string,
            buffer: Buffer,
        ): Promise<FileAsset> {
            const cid = await this.gatekeeper.addData(buffer);
            const type = await this.getMimeType(buffer);

            const file: FileAsset = {
                cid,
                filename,
                type,
                bytes: buffer.length,
            };

            return file;
        }

        async createDocument(
            buffer: Buffer,
            options: FileAssetOptions = {}
        ): Promise<string> {
            const filename = options.filename || 'document';
            const document = await this.generateFileAsset(filename, buffer);

            return this.createAsset({ document }, options);
        }

        async updateDocument(
            id: string,
            buffer: Buffer,
            options: FileAssetOptions = {}
        ): Promise<boolean> {
            const filename = options.filename || 'document';
            const document = await this.generateFileAsset(filename, buffer);

            return this.updateAsset(id, { document });
        }

        async getDocument(id: string): Promise<FileAsset | null> {
            const asset = await this.resolveAsset(id) as { document?: FileAsset };

            return asset.document ?? null;
        }

        async testDocument(id: string): Promise<boolean> {
            try {
                const document = await this.getDocument(id);
                return document !== null;
            }
            catch (error) {
                return false;
            }
        }
    };
}
