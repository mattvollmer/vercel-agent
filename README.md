# Vercel Deployment Slack Bot

A Slack bot that monitors Vercel deployments and automatically analyzes build failures.

## What It Does

- Posts Slack notifications when deployments succeed or fail
- Automatically fetches logs and analyzes failures in a thread
- Answers questions about deployments and build errors

## Required Environment Variables

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret

# Vercel
VERCEL_TOKEN=your-vercel-api-token
VERCEL_WEBHOOK_SECRET=your-webhook-secret

# Notifications (comma-separated for multiple channels)
SLACK_CHANNEL_ID=C1234567890,C0987654321
```

## Quick Setup

1. Create a Slack App with bot token and signing secret
2. Add a Vercel webhook pointing to your agent URL
3. Set the environment variables above
4. Deploy: `blink deploy`
