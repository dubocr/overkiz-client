/* eslint-disable no-console */
import OverkizClient from './Client';
import dotenv from 'dotenv';
import { Device, State } from '.';

dotenv.config();

async function main() {
    const client = new OverkizClient(console, {
        service: process.env.SERVICE,
        user: process.env.USERNAME,
        password: process.env.PASSWORD,
        pollingPeriod: 0,
        refreshPeriod: 30,
    });

    //await client.refreshStates();
    const devices = await client.getDevices();
    console.log(`${devices.length} devices`);
    devices.forEach((device: Device) => {
        console.log(`${device.parent ? ' ' : ''}\x1b[34m${device.label}\x1b[0m (${device.widget})`);
        device.sensors.forEach((sensor: Device) => console.log(`\t - \x1b[34m${sensor.label}\x1b[0m (${sensor.widget})`));
        device.on('states', (states) => {
            console.log(device.label + ' states updated');
            states.forEach((state: State) => console.log('\t - ' + state.name + '=' + state.value));
        });
    });

    process.openStdin().addListener('data', async (d) => {
        const data = d.toString().trim();
        console.log('Input: ' + data);
        await client.refreshDeviceStates(data);
    });
}
main().catch(console.error);