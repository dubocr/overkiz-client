import Device from './Device';
import Gateway from './Gateway';

export default interface Setup {
    gateways: Gateway[];
    devices: Device[];
}