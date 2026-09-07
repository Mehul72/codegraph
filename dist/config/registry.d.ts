export interface RegistryEntry {
    name: string;
    root: string;
    index: string;
    registeredAt: number;
}
export interface Registry {
    version: number;
    repos: RegistryEntry[];
}
export declare function loadRegistry(): Promise<Registry>;
export declare function saveRegistry(registry: Registry): Promise<void>;
/**
 * Add or refresh this repo's entry. Called after every successful index.
 *
 * The registry only exists to make cross-repo queries and `codegraph repos`
 * convenient, so a home directory we cannot write to is a warning and not a
 * failure. Build containers and locked-down machines are common enough that
 * throwing here would break indexing for people who never wanted the feature.
 */
export declare function registerRepo(name: string, root: string): Promise<void>;
export declare function unregisterRepo(root: string): Promise<boolean>;
/**
 * Accept either a name from the registry or a path on disk. Names win, since
 * that is what `codegraph repos` prints and what people will type.
 */
export declare function resolveRepoRef(ref: string): Promise<RegistryEntry | null>;
