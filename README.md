# Automatically Retry grammY API Requests (With Sentry integration)

Check out [the official documentation](https://grammy.dev/plugins/auto-retry) for the auto-retry plugin.  
You might also want to read about [broadcasting messages](https://grammy.dev/advanced/flood#how-to-broadcast-messages).

This plugin extends the default auto-retry plugin with **Sentry integration**.  
It allows you to automatically capture and report errors to Sentry whenever your bot retries or fails API requests.

---

## Quickstart

An [API transformer function](https://grammy.dev/advanced/transformers) lets you modify outgoing HTTP requests on the fly.  
This grammY plugin can automatically detect if an API request fails with a `retry_after` value.  
It will then intercept the error, wait the specified period of time, and retry the request.

### Basic usage

```ts
import { Bot } from "grammy";
import { autoRetrySentry } from "@vemorr/auto-retry-sentry";

const bot = new Bot(process.env.BOT_TOKEN);

// Install the plugin with default options (without Sentry)
bot.api.config.use(autoRetrySentry());
```

### Usage with Sentry

```ts
import { Bot } from "grammy";
import { autoRetrySentry } from "@vemorr/auto-retry-sentry";
import * as Sentry from "@sentry/node";

// Initialize Sentry
Sentry.init({
  dsn: process.env.SENTRY_DSN!,
  environment: "production",
  tracesSampleRate: 1.0,
});

const bot = new Bot(process.env.BOT_TOKEN);

// Install the plugin with Sentry enabled
bot.api.config.use(
  autoRetrySentry({
    maxRetryAttempts: 5,
    maxDelaySeconds: 60,
    rethrowHttpErrors: false,
    rethrowInternalServerErrors: false,
    sentry: {
      dsn: process.env.SENTRY_DSN!,
      environment: "production",
      tracesSampleRate: 1.0,
    },
  }),
);