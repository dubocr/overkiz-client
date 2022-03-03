import { EventEmitter } from 'events';
import Action from './Action';

export enum ExecutionState {
    INITIALIZED = 'INITIALIZED',
    NOT_TRANSMITTED = 'NOT_TRANSMITTED',
    TRANSMITTED = 'TRANSMITTED',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
    TIMED_OUT = 'TIMED_OUT'
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

export default class Execution extends EventEmitter {
    private timeout;

    public actions: Action[] = [];
    public metadata = null;

    constructor(public label: string, action?: Action) {
        super();
        if (action) {
            this.addAction(action);
        }
    }

    addAction(action: Action) {
        this.actions.push(action);
    }

    onStateUpdate(state, event) {
        this.emit('update', state, event);
        if (event?.failureType && event?.failedCommands) {
            this.actions.forEach((action) => {
                const failure = event.failedCommands.find((c) => c.deviceURL === action.deviceURL);
                if (failure) {
                    action.emit('update', ExecutionState.FAILED, failure);
                } else {
                    action.emit('update', ExecutionState.COMPLETED);
                }
            });
        } else {
            this.actions.forEach((action) => action.emit('update', state, event));
        }
    }
}