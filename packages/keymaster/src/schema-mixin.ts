import {
    InvalidParameterError,
} from '@didcid/common/errors';
import {
    ResolveDIDOptions,
} from '@didcid/gatekeeper/types';
import {
    CreateAssetOptions,
} from '@didcid/keymaster/types';

// Type for constructors
type Constructor<T = {}> = new (...args: any[]) => T;

const DefaultSchema = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
        "propertyName": {
            "type": "string"
        }
    },
    "required": [
        "propertyName"
    ]
};

// Interface describing the base class requirements for SchemaMixin
export interface SchemaMixinRequirements {
    createAsset(data: unknown, options?: CreateAssetOptions): Promise<string>;
    resolveAsset(did: string, options?: ResolveDIDOptions): Promise<any>;
    updateAsset(did: string, data: Record<string, unknown>): Promise<boolean>;
    lookupDID(name: string): Promise<string>;
    listAssets(owner?: string): Promise<string[]>;
}

export function SchemaMixin<TBase extends Constructor<SchemaMixinRequirements>>(Base: TBase) {
    return class SchemaImpl extends Base {
        _schema_validateSchema(schema: unknown): boolean {
            try {
                // Attempt to instantiate the schema
                this._schema_generateSchema(schema);
                return true;
            }
            catch (error) {
                return false;
            }
        }

        _schema_generateSchema(schema: unknown): Record<string, unknown> {
            if (
                typeof schema !== 'object' ||
                !schema ||
                !('$schema' in schema) ||
                !('properties' in schema)
            ) {
                throw new InvalidParameterError('schema');
            }

            const template: Record<string, unknown> = {};

            const props = (schema as { properties: Record<string, unknown> }).properties;
            for (const property of Object.keys(props)) {
                template[property] = "TBD";
            }

            return template;
        }

        async createSchema(
            schema?: unknown,
            options: CreateAssetOptions = {}
        ): Promise<string> {
            if (!schema) {
                schema = DefaultSchema;
            }

            if (!this._schema_validateSchema(schema)) {
                throw new InvalidParameterError('schema');
            }

            return this.createAsset({ schema }, options);
        }

        async getSchema(id: string): Promise<unknown | null> {
            const asset = await this.resolveAsset(id);
            if (!asset) {
                return null;
            }

            // TEMP during did:cid, return old version schemas
            const castOldAsset = asset as { properties?: unknown };
            if (castOldAsset.properties) {
                return asset;
            }

            const castAsset = asset as { schema?: unknown };
            if (!castAsset.schema) {
                return null;
            }

            return castAsset.schema;
        }

        async setSchema(
            id: string,
            schema: unknown
        ): Promise<boolean> {
            if (!this._schema_validateSchema(schema)) {
                throw new InvalidParameterError('schema');
            }

            return this.updateAsset(id, { schema });
        }

        // TBD add optional 2nd parameter that will validate JSON against the schema
        async testSchema(id: string): Promise<boolean> {
            try {
                const schema = await this.getSchema(id);

                // TBD Need a better way because any random object with keys can be a valid schema
                if (!schema || Object.keys(schema).length === 0) {
                    return false;
                }

                return this._schema_validateSchema(schema);
            }
            catch (error) {
                return false;
            }
        }

        async listSchemas(owner?: string): Promise<string[]> {
            const assets = await this.listAssets(owner);
            const schemas = [];

            for (const did of assets) {
                const isSchema = await this.testSchema(did);

                if (isSchema) {
                    schemas.push(did);
                }
            }

            return schemas;
        }

        async createTemplate(schemaId: string): Promise<Record<string, unknown>> {
            const isSchema = await this.testSchema(schemaId);

            if (!isSchema) {
                throw new InvalidParameterError('schemaId');
            }

            const schemaDID = await this.lookupDID(schemaId);
            const schema = await this.getSchema(schemaDID);
            const template = this._schema_generateSchema(schema);

            template['$schema'] = schemaDID;

            return template;
        }
    };
}
