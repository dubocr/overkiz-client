import OverkizClient from "./Client";
import Device, { State } from "./Device";
import dotenv from "dotenv";

dotenv.config();

async function main() {
    const client = new OverkizClient(() => console.log, {
        service: process.env.SERVICE,
        user: process.env.USERNAME,
        password: process.env.PASSWORD,
        pollingPeriod: 10,
        refreshPeriod: 120
    });

    const devices = await client.getDevices();
    //console.log(devices);
    devices.forEach((device: Device) => {
        //console.log(device.label);
        //device.sensors.forEach((sensor: Device) => console.log("\t - " + sensor.label));
        device.on('states', (states) => {
            console.log(device.label + ' states updated');
            states.forEach((state: State) => console.log("\t - " + state.name + '=' + state.value));
        });
    });
}
main().catch(console.error);