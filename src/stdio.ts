import http from 'http';

export interface StdioForwarderOptions {
    port?: number;
    host?: string;
    onClose?: () => void;
}

interface NormalizedMessage {
    payload: string;
    isNotification: boolean;
    id: unknown;
}

export class StdioForwarder {
    private readonly host: string;
    private port?: number;
    private buffer: Buffer = Buffer.alloc(0);
    private isFramed: boolean | null = null;
    private readonly queue: string[] = [];
    private flushing = false;
    private stdinEnded = false;
    private closed = false;
    private readonly onClose?: () => void;

    constructor(options: StdioForwarderOptions = {}) {
        this.host = options.host ?? '127.0.0.1';
        this.port = options.port;
        this.onClose = options.onClose;
    }

    public setPort(port: number): void {
        this.port = port;
        void this.flushQueue();
    }

    public start(): void {
        process.stdin.on('data', (chunk: Buffer) => this.handleData(chunk));
        process.stdin.on('end', () => this.handleStdinEnd());
        process.stdin.on('close', () => this.handleStdinEnd());
        process.stdin.resume();
    }

    private handleStdinEnd(): void {
        this.stdinEnded = true;
        this.checkClose();
    }

    private checkClose(): void {
        if (this.closed || !this.stdinEnded) {
            return;
        }
        if (this.flushing || this.queue.length > 0) {
            return;
        }
        this.closed = true;
        this.onClose?.();
    }

    private handleData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
    }

    private processBuffer(): void {
        while (this.buffer.length > 0) {
            // Skip leading whitespace / newlines between messages
            let start = 0;
            while (
                start < this.buffer.length &&
                (this.buffer[start] === 32 ||
                    this.buffer[start] === 9 ||
                    this.buffer[start] === 10 ||
                    this.buffer[start] === 13)
            ) {
                start++;
            }
            if (start > 0) {
                this.buffer = this.buffer.subarray(start);
                if (this.buffer.length === 0) break;
            }

            // Detect message framing: Content-Length header or newline-delimited JSON
            if (this.buffer[0] === 123 || this.buffer[0] === 91) { // '{' or '[' character
                const newlineIndex = this.buffer.indexOf(10); // '\n'
                if (newlineIndex !== -1) {
                    const lineBuf = this.buffer.subarray(0, newlineIndex);
                    this.buffer = this.buffer.subarray(newlineIndex + 1);
                    const line = lineBuf.toString('utf8').trim();
                    if (line) {
                        this.isFramed = false;
                        this.enqueueMessage(line);
                    }
                    continue;
                }
                // Incomplete line, wait for more data
                break;
            } else {
                // Header-delimited framing (Content-Length: ... \r\n\r\n <payload>)
                const headerEnd = this.buffer.indexOf('\r\n\r\n');
                if (headerEnd !== -1) {
                    const headerStr = this.buffer.subarray(0, headerEnd).toString('utf8');
                    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
                    if (match) {
                        const contentLength = parseInt(match[1], 10);
                        const headerByteLength = headerEnd + 4;
                        if (this.buffer.length >= headerByteLength + contentLength) {
                            const bodyBuf = this.buffer.subarray(headerByteLength, headerByteLength + contentLength);
                            this.buffer = this.buffer.subarray(headerByteLength + contentLength);
                            this.isFramed = true;
                            this.enqueueMessage(bodyBuf.toString('utf8'));
                            continue;
                        } else {
                            // Incomplete body, wait for more data
                            break;
                        }
                    } else {
                        // Unrecognized header, drop up to headerEnd + 4
                        this.buffer = this.buffer.subarray(headerEnd + 4);
                        continue;
                    }
                }
                // Incomplete header, wait for more data
                break;
            }
        }
    }

    private enqueueMessage(rawJson: string): void {
        this.queue.push(rawJson);
        void this.flushQueue();
    }

    private async flushQueue(): Promise<void> {
        if (this.flushing || this.port === undefined) {
            return;
        }
        this.flushing = true;
        try {
            while (this.queue.length > 0 && this.port !== undefined) {
                const next = this.queue.shift()!;
                await this.forwardMessage(next, this.port);
            }
        } finally {
            this.flushing = false;
            this.checkClose();
        }
    }

    private normalizeMessage(rawJson: string): NormalizedMessage {
        try {
            const parsed: unknown = JSON.parse(rawJson);
            if (Array.isArray(parsed)) {
                let modified = false;
                for (const item of parsed) {
                    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                        const obj = item as Record<string, unknown>;
                        if (typeof obj.method === 'string' && (obj.params === undefined || obj.params === null)) {
                            obj.params = {};
                            modified = true;
                        }
                    }
                }
                const allNotifications =
                    parsed.length > 0 &&
                    parsed.every(
                        (item) =>
                            typeof item === 'object' &&
                            item !== null &&
                            !Array.isArray(item) &&
                            typeof (item as Record<string, unknown>).method === 'string' &&
                            !('id' in item)
                    );
                return {
                    payload: modified ? JSON.stringify(parsed) : rawJson,
                    isNotification: allNotifications,
                    id: undefined,
                };
            }

            if (typeof parsed === 'object' && parsed !== null) {
                const obj = parsed as Record<string, unknown>;
                const isRequestOrNotification = typeof obj.method === 'string';
                const hasId = 'id' in obj;
                const isNotification = isRequestOrNotification && !hasId;
                const id = hasId ? obj.id : undefined;

                if (isRequestOrNotification && (obj.params === undefined || obj.params === null)) {
                    obj.params = {};
                    return {
                        payload: JSON.stringify(obj),
                        isNotification,
                        id,
                    };
                }

                return {
                    payload: rawJson,
                    isNotification,
                    id,
                };
            }
        } catch {
            // Fall through and forward raw payload as-is
        }

        return {
            payload: rawJson,
            isNotification: false,
            id: undefined,
        };
    }

    private forwardMessage(rawJson: string, port: number): Promise<void> {
        const { payload, isNotification, id } = this.normalizeMessage(rawJson);
        const postData = Buffer.from(payload, 'utf8');

        return new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            const req = http.request(
                {
                    hostname: this.host,
                    port,
                    path: '/',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': postData.length,
                    },
                },
                (res) => {
                    let body = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk) => {
                        body += chunk;
                    });
                    res.on('end', () => {
                        if (!isNotification && body && body.trim().length > 0) {
                            this.sendStdout(body.trim());
                        }
                        finish();
                    });
                    res.on('error', (err) => {
                        process.stderr.write(`[devsense-php-mcp] Response error: ${err.message}\n`);
                        if (!isNotification && id !== undefined) {
                            this.sendStdout(
                                JSON.stringify({
                                    jsonrpc: '2.0',
                                    id,
                                    error: { code: -32603, message: err.message },
                                })
                            );
                        }
                        finish();
                    });
                }
            );

            req.on('error', (err) => {
                process.stderr.write(`[devsense-php-mcp] Forwarding error: ${err.message}\n`);
                if (!isNotification && id !== undefined) {
                    this.sendStdout(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32603, message: err.message },
                        })
                    );
                }
                finish();
            });

            req.write(postData);
            req.end();
        });
    }

    private sendStdout(responseJson: string): void {
        if (this.isFramed) {
            const bodyBuf = Buffer.from(responseJson, 'utf8');
            process.stdout.write(`Content-Length: ${bodyBuf.length}\r\n\r\n${responseJson}`);
        } else {
            let singleLine = responseJson;
            if (singleLine.includes('\n') || singleLine.includes('\r')) {
                try {
                    singleLine = JSON.stringify(JSON.parse(singleLine));
                } catch {
                    singleLine = singleLine.replace(/[\r\n]+/g, ' ');
                }
            }
            process.stdout.write(`${singleLine}\n`);
        }
    }
}


