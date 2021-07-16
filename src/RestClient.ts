import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import { URLSearchParams } from 'url';
import { logger } from './Client';

const API_LOCKDOWN_DELAY = 60 * 60 * 1000;

export default class RestClient extends EventEmitter {
    private http: AxiosInstance;
    private authRequest?: Promise<unknown>;
    private isLogged = false;
    private badCredentials = false;

    constructor(private readonly user: string, private readonly password: string, private readonly baseUrl: string) {
        super();
        this.http = axios.create({
            baseURL: baseUrl,
            withCredentials: true,
        });

        this.http.interceptors.request.use(request => {
            logger.debug('Request', request.url);
            return request;
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

    private request(options) {
        if (this.badCredentials) {
            throw 'API client locked. Please check your credentials then restart.\n'
            + 'If your credentials are valid, please wait some hours to be unbanned';
        }
        let request;
        if (this.isLogged) {
            request = this.http(options);
        } else {
            if (this.authRequest === undefined) {
                const params = new URLSearchParams();
                params.append('userId', this.user);
                params.append('userPassword', this.password);
                this.authRequest = this.http.post('/login', params)
                    .then((response) => {
                        this.isLogged = true;
                        if (response.headers['set-cookie']) {
                            this.http.defaults.headers.common['Cookie'] = response.headers['set-cookie'];
                        }
                        this.emit('connect');
                    }).finally(() => {
                        this.authRequest = undefined;
                    });
            }
            request = this.authRequest.then(() => this.http(options));
        }

        return request
            .then((response) => response.data)
            .catch((error) => {
                if (error.response) {
                    if (error.response.status === 401) { // Reauthenticate
                        if (this.isLogged) {
                            this.isLogged = false;
                            this.emit('disconnect');
                            return this.request(options);
                        } else {
                            if (error.response.data.errorCode === 'AUTHENTICATION_ERROR') {
                                this.badCredentials = true;
                                logger.warn(
                                    'API client will be locked for ' + (API_LOCKDOWN_DELAY / 60000) + ' min because of bad credentials',
                                );
                                setTimeout(() => {
                                    this.badCredentials = false;
                                }, API_LOCKDOWN_DELAY);
                            }
                            throw error.response.data.error;
                        }
                    } else {
                        //logger.debug(error.response.data);
                        let msg = 'Error ' + error.response.status;
                        const json = error.response.data;
                        if (json && json.error) {
                            msg += ' ' + json.error;
                        }
                        if (json && json.errorCode) {
                            msg += ' (' + json.errorCode + ')';
                        }
                        logger.debug(msg);
                        throw msg;
                    }
                } else if (error.message) {
                    logger.debug('Error:', error.message);
                    throw error.message;
                } else {
                    logger.debug('Error:', error);
                    throw error;
                }
            });
    }
}
