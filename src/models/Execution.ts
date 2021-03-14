import Action from "./Action";

export enum ExecutionState {
    INITIALIZED = 'INITIALIZED',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED'
}

export class ExecutionError extends Error {
    public readonly state;
    constructor(state, error) {
        super(error);
        this.state = state;
    }
}

export interface ExecutionStateEvent {
    readonly timestamp: number;
    readonly setupOID;
    readonly execId;
    readonly newState: ExecutionState;
    readonly ownerKey;
    readonly type: number;
    readonly subType: number;
    readonly oldState: ExecutionState;
    readonly timeToNextState: number;
    readonly name;
}

export default class Execution {
    private timeout;

    public actions: Action[] = [];
    public metadata = null;

    constructor(public label: string, action: Action) {
        this.addAction(action);
    }

    addAction(action: Action) {
        this.actions.push(action);
    }

    onStateUpdate(state, event) {
        //Log(event);
        if(event.failureType && event.failedCommands) {
            this.actions.forEach((action) => {
                const failure = event.failedCommands.find((c) => c.deviceURL === action.deviceURL);
                if(failure) {
                    action.emit('update', ExecutionState.FAILED, failure);
                } else {
                    action.emit('update', ExecutionState.COMPLETED);
                }
            });
        } else {
            this.actions.forEach((action) => action.emit('update', state, event));
        }
    }x
}