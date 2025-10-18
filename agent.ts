import { convertToModelMessages, streamText, tool } from "ai";
import * as blink from "blink";
import * as slack from "@blink-sdk/slack";
import { App } from "@slack/bolt";
import { createHmac } from "crypto";
import { z } from "zod";

const receiver = new slack.Receiver();
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
});

// Handle messages in channels (only when @mentioned)
app.event("app_mention", async ({ event }) => {
  const chat = await agent.chat.upsert([
    "slack",
    event.channel,
    event.thread_ts ?? event.ts,
  ]);
  const { message } = await slack.createMessageFromEvent({
    client: app.client,
    event,
  });
  await agent.chat.sendMessages(chat.id, [message]);
  await app.client.assistant.threads.setStatus({
    channel_id: event.channel,
    status: "is typing...",
    thread_ts: event.thread_ts ?? event.ts,
  });
});

// Handle direct messages (always respond)
app.event("message", async ({ event }) => {
  // Ignore bot messages and message changes
  if (event.subtype || event.bot_id) {
    return;
  }
  // Only handle DMs (channel type is 'im')
  const channelInfo = await app.client.conversations.info({
    channel: event.channel,
  });
  if (!channelInfo.channel?.is_im) {
    return;
  }
  const chat = await agent.chat.upsert(["slack", event.channel]);
  const { message } = await slack.createMessageFromEvent({
    client: app.client,
    event,
  });
  await agent.chat.sendMessages(chat.id, [message]);
  await app.client.assistant.threads.setStatus({
    channel_id: event.channel,
    status: "is typing...",
    thread_ts: event.thread_ts ?? event.ts,
  });
});

const agent = new blink.Agent();

agent.on("request", async (request) => {
  const url = new URL(request.url);
  
  console.log("[REQUEST] Incoming request:", {
    method: request.method,
    pathname: url.pathname,
    headers: Object.fromEntries(request.headers.entries()),
  });

  // Handle Vercel deployment webhooks - must return early to avoid Slack receiver
  // Check for x-vercel-signature header since Vercel may hit different paths
  if (request.headers.get("x-vercel-signature") && request.method === "POST") {
    console.log("[VERCEL] Detected Vercel webhook (signature present)");
    try {
      const body = await request.text();
      console.log("[VERCEL] Request body length:", body.length);
      const signature = request.headers.get("x-vercel-signature");
      console.log("[VERCEL] Signature present:", !!signature);

      // Verify webhook signature
      if (!signature || !process.env.VERCEL_WEBHOOK_SECRET) {
        console.error("[VERCEL] Missing signature or webhook secret", {
          hasSignature: !!signature,
          hasSecret: !!process.env.VERCEL_WEBHOOK_SECRET,
        });
        return new Response("Unauthorized", { status: 401 });
      }

      const hmac = createHmac("sha1", process.env.VERCEL_WEBHOOK_SECRET);
      hmac.update(body);
      const expectedSignature = hmac.digest("hex");

      if (signature !== expectedSignature) {
        console.error("[VERCEL] Invalid signature", {
          received: signature,
          expected: expectedSignature,
        });
        return new Response("Unauthorized", { status: 401 });
      }
      
      console.log("[VERCEL] Signature verified successfully");

      // Parse the deployment event
      const event = JSON.parse(body);
      console.log("[VERCEL] Received deployment event:", event.type);
      console.log("[VERCEL] Full event payload:", JSON.stringify(event, null, 2));

      // Handle deployment success and error events
      if (event.type === "deployment.succeeded" || event.type === "deployment.failed" || event.type === "deployment.error") {
        // Process asynchronously to avoid webhook timeout
        (async () => {
          try {
          const deployment = event.payload.deployment;
          const success = event.type === "deployment.succeeded";
          
          // Extract data from the correct locations in the payload
          const projectName = event.payload.name; // Project name is at payload.name
          const deploymentUrl = deployment?.url;
          const deploymentId = deployment?.id;
          const target = event.payload.target; // Target is at payload.target, not deployment.target
          const environment = target || "preview"; // Default to "preview" if no target
          
          console.log("[VERCEL] Extracted data:", {
            projectName,
            deploymentUrl,
            deploymentId,
            target,
            environment,
          });
          
          // For failed deployments, just get basic error info (don't fetch logs yet)
          let errorSummary = "Build failed. Ask me for details to see the full error logs.";
          if (!success && process.env.VERCEL_TOKEN && deploymentId) {
            try {
              console.log("[VERCEL] Fetching basic deployment details");
              const detailsResponse = await fetch(
                `https://api.vercel.com/v13/deployments/${deploymentId}`,
                {
                  headers: {
                    Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
                  },
                }
              );
              
              if (detailsResponse.ok) {
                const deploymentDetails = await detailsResponse.json() as any;
                if (deploymentDetails.readyState === "ERROR" || deploymentDetails.readyState === "FAILED") {
                  errorSummary = deploymentDetails.errorMessage || deploymentDetails.errorCode || "Build failed";
                }
              }
            } catch (fetchError) {
              console.error("[VERCEL] Error fetching deployment details:", fetchError);
            }
          }

          // Get channel IDs for notifications (can be multiple channels)
          const storedChannels = await agent.store.get(`notify-channels:${projectName}`);
          let notificationChannels: string[] = [];
          
          if (storedChannels) {
            // Parse stored channels (JSON array)
            try {
              notificationChannels = JSON.parse(storedChannels);
            } catch (e) {
              console.error(`Failed to parse stored channels for ${projectName}:`, e);
            }
          }
          
          // Fallback to SLACK_CHANNEL_ID env var if no project-specific config
          if (notificationChannels.length === 0 && process.env.SLACK_CHANNEL_ID) {
            notificationChannels = [process.env.SLACK_CHANNEL_ID];
          }
          
          if (notificationChannels.length === 0) {
            console.error(`No notification channels configured for ${projectName}. Set SLACK_CHANNEL_ID env var or configure via chat.`);
            return new Response("OK", { status: 200 });
          }
          
          console.log(`[VERCEL] Posting notification to ${notificationChannels.length} channel(s):`, notificationChannels);

          // Send notification message
          const emoji = success ? ":white_check_mark:" : ":x:";
          const status = success ? "succeeded" : "failed";

          const blocks: any[] = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${emoji} *Deployment ${status}*`,
              },
            },
            {
              type: "section",
              fields: [
                {
                  type: "mrkdwn",
                  text: `*Project:*\n${projectName}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Status:*\n${status}`,
                },
                {
                  type: "mrkdwn",
                  text: `*URL:*\n<https://${deploymentUrl}|${deploymentUrl}>`,
                },
                {
                  type: "mrkdwn",
                  text: `*Environment:*\n${environment}`,
                },
              ],
            },
          ];
          
          // Add error summary if available
          if (errorSummary) {
            blocks.push({
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Error:*\n\`\`\`${errorSummary}\`\`\``,
              },
            });
          }

          // Store minimal deployment info (logs fetched on-demand)
          const deploymentKey = `deployment:${deploymentId}`;
          
          try {
            await agent.store.set(deploymentKey, JSON.stringify({
              id: deploymentId,
              projectName,
              url: deploymentUrl,
              environment,
              status,
              success,
              errorSummary,
              timestamp: Date.now(),
            }));
            
            // Store latest deployment reference for easy lookup
            await agent.store.set(`latest-deployment:${projectName}`, deploymentId);
            
            console.log(`[VERCEL] Stored deployment info: ${deploymentKey}`);
          } catch (storageError) {
            console.error(`[VERCEL] Failed to store deployment info:`, storageError);
            console.log(`[VERCEL] Continuing with notification despite storage failure`);
          }

          // Post notification to all configured channels
          for (const channelId of notificationChannels) {
            try {
              await app.client.chat.postMessage({
                channel: channelId,
                text: `${emoji} Deployment ${status}: ${projectName}`,
                blocks,
              });
              console.log(`[VERCEL] Sent ${status} notification to ${channelId}`);
            } catch (postError) {
              console.error(`[VERCEL] Failed to post to channel ${channelId}:`, postError);
            }
          }

          console.log(`[VERCEL] Finished sending notifications for ${projectName}`);
          } catch (notificationError) {
            console.error("[VERCEL] Error sending Slack notification:", notificationError);
          }
        })(); // Execute async immediately but don't wait
      }

      // Always return OK for Vercel webhooks immediately (even if we don't handle the event type)
      console.log("[VERCEL] Returning 200 OK immediately");
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("[VERCEL] Error handling Vercel webhook:", error);
      // Return 200 even on error to prevent Vercel from retrying
      console.log("[VERCEL] Returning 200 OK after error");
      return new Response("OK", { status: 200 });
    }
  }

  // Only pass to Slack receiver if it's not a Vercel webhook
  console.log("[SLACK] Passing request to Slack receiver");
  return receiver.handle(app, request);
});

agent.on("chat", async ({ messages }) => {
  const slackTools = slack.createTools({ client: app.client });
  
  // Add deployment tools
  const deploymentTools = {
    get_latest_deployment: tool({
      description: "Get information about the latest deployment for a project, including error details if it failed",
      inputSchema: z.object({
        projectName: z.string().describe("The name of the project (e.g., 'coder.com')"),
      }),
      execute: async ({ projectName }) => {
        const deploymentId = await agent.store.get(`latest-deployment:${projectName}`);
        if (!deploymentId) {
          return { error: `No deployment found for project: ${projectName}` };
        }
        const deploymentData = await agent.store.get(`deployment:${deploymentId}`);
        if (!deploymentData) {
          return { error: `Deployment data not found for ID: ${deploymentId}` };
        }
        return JSON.parse(deploymentData);
      },
    }),
    get_deployment_by_id: tool({
      description: "Get detailed information about a specific deployment by its ID",
      inputSchema: z.object({
        deploymentId: z.string().describe("The Vercel deployment ID"),
      }),
      execute: async ({ deploymentId }) => {
        const deploymentData = await agent.store.get(`deployment:${deploymentId}`);
        if (!deploymentData) {
          return { error: `Deployment not found: ${deploymentId}` };
        }
        return JSON.parse(deploymentData);
      },
    }),
    list_recent_deployments: tool({
      description: "List recent deployments across all projects",
      inputSchema: z.object({
        limit: z.number().optional().describe("Maximum number of deployments to return (default: 10)"),
      }),
      execute: async ({ limit = 10 }) => {
        const result = await agent.store.list("deployment:", { limit });
        const deployments = [];
        for (const entry of result.entries) {
          const deploymentData = await agent.store.get(entry.key);
          if (deploymentData) {
            deployments.push(JSON.parse(deploymentData));
          }
        }
        // Sort by timestamp descending
        deployments.sort((a: any, b: any) => b.timestamp - a.timestamp);
        return { deployments };
      },
    }),
    configure_notifications: tool({
      description: "Add a Slack channel to receive deployment notifications for a specific project. Use this when users say 'send notifications here' or 'notify this channel about deployments'.",
      inputSchema: z.object({
        projectName: z.string().describe("The name of the Vercel project (e.g., 'coder.com')"),
        channelId: z.string().describe("The Slack channel ID where notifications should be posted"),
      }),
      execute: async ({ projectName, channelId }) => {
        // Get existing channels
        const storedChannels = await agent.store.get(`notify-channels:${projectName}`);
        let channels: string[] = [];
        if (storedChannels) {
          try {
            channels = JSON.parse(storedChannels);
          } catch (e) {
            console.error('Failed to parse stored channels:', e);
          }
        }
        
        // Add channel if not already in list
        if (!channels.includes(channelId)) {
          channels.push(channelId);
          await agent.store.set(`notify-channels:${projectName}`, JSON.stringify(channels));
          return { success: true, message: `Added <#${channelId}> to receive ${projectName} deployment notifications. Total channels: ${channels.length}` };
        } else {
          return { success: true, message: `<#${channelId}> is already configured to receive ${projectName} notifications.` };
        }
      },
    }),
    remove_notification_channel: tool({
      description: "Remove a channel from receiving deployment notifications for a project",
      inputSchema: z.object({
        projectName: z.string().describe("The name of the Vercel project"),
        channelId: z.string().describe("The Slack channel ID to remove"),
      }),
      execute: async ({ projectName, channelId }) => {
        const storedChannels = await agent.store.get(`notify-channels:${projectName}`);
        if (!storedChannels) {
          return { success: false, message: `No notification channels configured for ${projectName}` };
        }
        
        try {
          let channels: string[] = JSON.parse(storedChannels);
          const originalLength = channels.length;
          channels = channels.filter(ch => ch !== channelId);
          
          if (channels.length === originalLength) {
            return { success: false, message: `<#${channelId}> was not configured for ${projectName} notifications` };
          }
          
          await agent.store.set(`notify-channels:${projectName}`, JSON.stringify(channels));
          return { success: true, message: `Removed <#${channelId}> from ${projectName} notifications. Remaining channels: ${channels.length}` };
        } catch (e) {
          return { success: false, message: `Failed to parse channel configuration: ${e}` };
        }
      },
    }),
    get_notification_config: tool({
      description: "Get the current notification channel configuration for a project",
      inputSchema: z.object({
        projectName: z.string().describe("The name of the Vercel project"),
      }),
      execute: async ({ projectName }) => {
        const storedChannels = await agent.store.get(`notify-channels:${projectName}`);
        if (!storedChannels) {
          return { configured: false, message: `No notification channels configured for ${projectName}` };
        }
        
        try {
          const channels: string[] = JSON.parse(storedChannels);
          const channelList = channels.map(ch => `<#${ch}>`).join(', ');
          return { configured: true, channels, message: `Notifications for ${projectName} are posted to: ${channelList}` };
        } catch (e) {
          return { configured: false, message: `Failed to parse channel configuration: ${e}` };
        }
      },
    }),
    get_deployment_logs: tool({
      description: "Fetch detailed build logs for a deployment. Use this when users ask about specific errors, warnings, or want to see what went wrong.",
      inputSchema: z.object({
        deploymentId: z.string().describe("The Vercel deployment ID"),
      }),
      execute: async ({ deploymentId }) => {
        if (!process.env.VERCEL_TOKEN) {
          return { error: "VERCEL_TOKEN not configured" };
        }
        
        try {
          // Fetch build logs
          const logsResponse = await fetch(
            `https://api.vercel.com/v2/deployments/${deploymentId}/events`,
            {
              headers: {
                Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
              },
            }
          );
          
          if (!logsResponse.ok) {
            return { error: `Failed to fetch logs: ${logsResponse.status}` };
          }
          
          const logsData = await logsResponse.text();
          
          // Parse NDJSON logs
          const logLines = logsData.trim().split('\n').map(line => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          }).filter(Boolean);
          
          // Extract error and warning messages
          const errorLogs = logLines.filter((log: any) => 
            log.type === 'stderr' || 
            log.type === 'command' || 
            (log.payload?.text && (log.payload.text.toLowerCase().includes('error') || log.payload.text.toLowerCase().includes('warning') || log.payload.text.toLowerCase().includes('fail')))
          );
          
          if (errorLogs.length > 0) {
            const logs = errorLogs.map((log: any) => log.payload?.text || log.text).filter(Boolean).join('\n');
            // Return last 10KB to avoid overwhelming the context
            const truncatedLogs = logs.length > 10000 ? `...truncated...\n\n${logs.slice(-10000)}` : logs;
            return { logs: truncatedLogs, totalLines: errorLogs.length };
          }
          
          return { logs: "No error or warning logs found", totalLines: 0 };
        } catch (e) {
          return { error: `Failed to fetch logs: ${e}` };
        }
      },
    }),
  };
  
  const tools = { ...slackTools, ...deploymentTools };
  
  const lastMessage = messages[messages.length - 1];
  const threadInfo = lastMessage?.metadata as
    | { channel?: string; thread_ts?: string }
    | undefined;

  // Add instruction to clear status after completion
  if (threadInfo?.channel && threadInfo?.thread_ts) {
    const clonedMessages = structuredClone(messages);
    const lastClonedMessage = clonedMessages[clonedMessages.length - 1];
    if (lastClonedMessage) {
      lastClonedMessage.parts.push({
        type: "text",
        text: `*INTERNAL INSTRUCTION*: Clear the status of this thread after you finish: channel=${threadInfo.channel} thread_ts=${threadInfo.thread_ts}`,
      });
    }
    messages = clonedMessages;
  }

  return streamText({
    model: "anthropic/claude-sonnet-4.5",
    system: `You are a helpful Slack bot assistant with access to Vercel deployment information.

When users ask about build failures or deployments, use the deployment tools to retrieve the stored information. The stored data includes: errorSummary (AI-generated summary), rawErrorDetails (full error messages), and buildLogs (complete build output including warnings, errors, and stack traces). You have full access to all build logs and warnings - use them to provide detailed debugging help.

When users say things like "send notifications here" or "notify this channel about deployments", use the configure_notifications tool with the current channel ID (${threadInfo?.channel}) to set up where deployment notifications should be posted for a specific project.`,
    messages: convertToModelMessages(messages, {
      ignoreIncompleteToolCalls: true,
      tools,
    }),
    tools,
  });
});

agent.serve();
