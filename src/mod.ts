import {
    type AbortSignal,
    debug as d,
    HttpError,
    type Transformer,
} from "./platform.deno.ts";
import * as Sentry from "@sentry/node";
const debug = d("vemorr:auto-retry-sentry");

const ONE_HOUR = 3600; // seconds
const INITIAL_LAST_DELAY = 3; // seconds

function pause(seconds: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const handle = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, 1000 * seconds);
        signal?.addEventListener("abort", abort);
        function abort() {
            clearTimeout(handle);
            signal?.removeEventListener("abort", abort);
            reject(new Error("Request aborted while waiting between retries"));
        }
    });
}

/**
 * Options that can be specified when creating an auto retry transformer
 * function.
 */
export interface AutoRetrySentryOptions {
    /**
     * Determines the maximum number of seconds that should be regarded from the
     * `retry_after` parameter. If the `retry_after` value exceeds this
     * threshold, the error will be passed on, hence failing the request. For
     * instance, this is useful if you don't want your bot to retry sending
     * messages that are too old.
     *
     * The default value is `Infinity`. This means that the threshold is
     * disabled. The plugin will wait any number of seconds.
     */
    maxDelaySeconds: number;
    /**
     * Determines the maximum number of times that an API request should be
     * retried. If the request has been retried the specified number of times
     * but still fails, the error will be rethrown, eventually failing the
     * request.
     *
     * The default value is `Infinity`. This means that the threshold is
     * disabled. The plugin will attempt to retry requests indefinitely.
     */
    maxRetryAttempts: number;
    /**
     * Requests to the Telegram servers can sometimes encounter internal server
     * errors (error with status code >= 500). Those are usually not something
     * you can fix in your code. They often are temporary issues, but even if
     * they persist, they require a fix by the web server or any potential
     * proxies. It is therefore the best strategy to retry such errors
     * automatically, which is what this plugin does by default.
     *
     * Set this option to `true` if the plugin should rethrow internal server
     * errors rather than retrying the respective requests automatically.
     *
     * (https://en.m.wikipedia.org/wiki/List_of_HTTP_status_codes#5xx_server_errors)
     */
    rethrowInternalServerErrors: boolean;
    /**
     * Network requests can sometimes fail, especially when the network
     * connection is flaky or unstable, or when intermediate hops are rebooting
     * or are unreliable. When a network request fails in this way, grammY
     * throws an `HttpError`. If these errors only happen occasionally, it is
     * usually not something that you can fix in your code. It is therefore the
     * best strategy to retry such errors automatically, which is what this
     * plugin does by default.
     *
     * Set this option to `true` if the plugin should rethrow networking errors
     * (`HttpError` instances) rather than retrying the respective requests
     * automatically.
     */
    rethrowHttpErrors: boolean;

    sentry?: {
        dsn: string;
        environment?: string;
        tracesSampleRate?: number;
    };
}

/**
 * Creates an [API transformer
 * function](https://grammy.dev/advanced/transformers.html) that will check
 * failed API requests for a `retry_after` value, and attempt to perform them
 * again after waiting the specified number of seconds.
 *
 * You can set an option to only retry requests a number of times, or only retry
 * those that to not demand your bot to wait too long.
 *
 * @param options Configuration options
 * @returns The created API transformer function
 */
export function autoRetrySentry(options?: Partial<AutoRetrySentryOptions>): Transformer {
    const maxDelay = options?.maxDelaySeconds ?? Infinity;
    const maxRetries = options?.maxRetryAttempts ?? Infinity;
    const rethrowInternalServerErrors = options?.rethrowInternalServerErrors ?? false;
    const rethrowHttpErrors = options?.rethrowHttpErrors ?? false;

    if (options?.sentry?.dsn) {
        Sentry.init({
            dsn: options.sentry.dsn,
            environment: options.sentry.environment ?? "production",
            tracesSampleRate: options.sentry.tracesSampleRate ?? 1.0,
        });
        debug("Sentry initialized");
    }

    return async (prev, method, payload, signal) => {
        let remainingAttempts = maxRetries;
        let nextDelay = INITIAL_LAST_DELAY;

        async function backoff() {
            await pause(nextDelay, signal);
            nextDelay = Math.min(ONE_HOUR, nextDelay + nextDelay);
        }

        async function call() {
            let res: ReturnType<typeof prev> | undefined = undefined;
            while (res === undefined) {
                try {
                    res = await prev(method, payload, signal);
                } catch (e: any) {
                    if ((signal === undefined || !signal.aborted) &&
                        !rethrowHttpErrors &&
                        e instanceof HttpError) {
                        debug(`HttpError thrown, retrying '${method}' in ${nextDelay}s (${e.message})`);
                        await backoff();
                        continue;
                    } else {
                        if (options?.sentry?.dsn) {
                            Sentry.captureException(e);
                            if ('message' in e) {
                                debug(`Error sent to Sentry: ${e.message}`);
                            } else {
                                debug(`Error sent to Sentry: ${e}`);
                            }
                        }
                        throw e;
                    }
                }
            }
            return res;
        }

        let result: ReturnType<typeof prev> | undefined = undefined;
        do {
            let retry = false;
            try {
                result = await call();
            } catch (e) {
                if (options?.sentry?.dsn) {
                    Sentry.captureException(e);
                }
                throw e;
            }

            if (typeof result.parameters?.retry_after === "number" &&
                result.parameters.retry_after <= maxDelay) {
                debug(`Rate limit hit, retrying '${method}' in ${result.parameters.retry_after}s`);
                await pause(result.parameters.retry_after, signal);
                nextDelay = INITIAL_LAST_DELAY;
                retry = true;
            } else if (result.error_code >= 500 && !rethrowInternalServerErrors) {
                debug(`Internal server error, retrying '${method}' in ${nextDelay}s`);
                await backoff();
                retry = true;
            }

            if (!retry) return result;
        } while (!result.ok && remainingAttempts-- > 0);

        return result;
    };
}