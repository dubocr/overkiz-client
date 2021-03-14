import { Action } from "..";

export default interface ActionGroup {
    oid: string;
    label: string;
    actions: Action[];
    metadata: string;
}