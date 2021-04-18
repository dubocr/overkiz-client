import axios from 'axios';
import { EventEmitter } from 'events';
import { URLSearchParams } from 'url';
import { logger } from './Client';

export default class RestClient extends EventEmitter {
    cookies: string;
    logged: boolean;
    authRequest: Promise<unknown>|null = null;
    http;

    constructor(private readonly user: string, private readonly password: string, private readonly baseUrl: string) {
        super();
        this.cookies = '';
        this.logged = false;
        this.http = axios.create({
            baseURL: baseUrl,
            withCredentials: true,
        });

        this.http.interceptors.request.use(request => {
            //logger.log('Request', request.url);
            return request;
        });
    }

    private request(options) {
        let request;
        if(this.logged) {
            request = this.http(options);
        } else {
            if(this.authRequest === null) {
                const params = new URLSearchParams();
                params.append('userId', this.user);
                params.append('userPassword', this.password);
                this.authRequest = this.http.post('/login', params)
                    .then((response) => {
                        this.authRequest = null;
                        this.logged = true;
                        if(response.headers['set-cookie']) {
                            this.http.defaults.headers.common['Cookie'] = response.headers['set-cookie'];
                        }
                        this.emit('connect');
                    })
                    .finally(() => {
                        this.authRequest = null;
                    });
            }
            request = this.authRequest?.then(() => this.http(options));
        }

        return request
            .then((response) => response.data)
            .catch((error) => {
                if(error.response) {
                    if (error.response.status === 401) { // Reauthenticated
                        if(this.logged) {
                            this.logged = false;
                            this.emit('disconnect');
                            return this.request(options);
                        } else {
                            throw error.response.data.error;
                        }
                    } else {
                        //logger.debug(error.response.data);
                        let msg = 'Error ' + error.response.status;
                        const json = error.response.data;
                        if(json && json.error) {
                            msg += ' ' + json.error;
                        }
                        if(json && json.errorCode) {
                            msg += ' (' + json.errorCode + ')';
                        }
                        logger.debug(msg);
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
