import axios from 'axios';
import { EventEmitter } from 'events';
import { URLSearchParams } from 'url';
import { logger } from './Client';

export default class RestClient extends EventEmitter {
    cookies: string;
    logged: boolean;
    authRequest: Promise<unknown>|null = null;

    constructor(private readonly user: string, private readonly password: string, private readonly baseUrl: string) {
        super();
        this.cookies = '';
        this.logged = false;
        axios.defaults.baseURL = baseUrl;
        axios.defaults.withCredentials = true;

        axios.interceptors.request.use(request => {
            //logger.log('Request', request.url);
            return request;
        });
    }

    private request(options) {
        let request;
        if(this.logged) {
            request = axios(options);
        } else {
            if(this.authRequest === null) {
                const params = new URLSearchParams();
                params.append('userId', this.user);
                params.append('userPassword', this.password);
                this.authRequest = axios.post('/login', params)
                    .then((response) => {
                        this.authRequest = null;
                        this.logged = true;
                        if(response.headers['set-cookie']) {
                            axios.defaults.headers.common['Cookie'] = response.headers['set-cookie'];
                        }
                        this.emit('connect');
                    })
                    .finally(() => {
                        this.authRequest = null;
                    });
            }
            request = this.authRequest.then(() => axios(options));
        }

        return request
            .then((response) => response.data)
            .catch((error) => {
                if(error.response) {
                    if (error.response.status === 401) { // Reauthenticated
                        if(this.logged) {
                            this.logged = false;
                            return this.request(options);
                        } else {
                            throw error.response.data.error;
                        }
                    } else {
                        let msg = 'Error ' + error.response.statusCode;
                        logger.log(error.response.data);
                        const json = error.response.data;
                        if(json && json.error !== null) {
                            msg += ' ' + json.error;
                        }
                        if(json && json.errorCode !== null) {
                            msg += ' (' + json.errorCode + ')';
                        }
                        logger.log(msg);
                        throw msg;
                    }
                } else if (error.request) {
                    logger.error('Error: ' + error.request);
                    throw error;
                } else {
                    logger.error('Error: ' + error.message);
                    throw error;
                }
            });
    }

    public get(url: string) {
        return this.request({
            method: 'get',
            url: url,
        });
    }

    public post(url: string, data?: Record<string, unknown>) {
        return this.request({
            method: 'post',
            url: url,
            data: data,
        });
    }

    public put(url: string, data?: Record<string, unknown>) {
        return this.request({
            method: 'put',
            url: url,
            data: data,
        });
    }

    public delete(url: string) {
        return this.request({
            method: 'delete',
            url: url,
        });
    }
}
