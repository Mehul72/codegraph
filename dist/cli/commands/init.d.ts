export interface InitOptions {
    agents?: string;
    skipAgents?: boolean;
    force?: boolean;
}
/**
 * The one command a new user runs. It has to work with no arguments, no
 * questions, and no follow-up steps: detect the repo, detect the languages,
 * detect the agents, build the index, wire everything up, and print something
 * the user can immediately try.
 */
export declare function initCommand(options: InitOptions): Promise<void>;
