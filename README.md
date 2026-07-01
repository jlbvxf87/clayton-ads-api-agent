# Ads API Agent (Clayton)

**Facebook and Google Ads API agent for campaign creation, ad management, creative testing, and paid media workflow automation.**

_This public repo is a sanitized demonstration based on real implementation patterns. Client-specific code, credentials, data, and proprietary logic have been removed._

---

## Business Problem

Paid media teams spend hours manually creating campaigns, duplicating ad sets, and updating creative. Most ad platforms have APIs, but building agents that use them intelligently requires combining API access with LLM reasoning.

## What I Built

Clayton — an AI agent that connects to the Facebook Marketing API and Google Ads API to read current campaign state, take action based on business logic, and assist with the full paid media workflow.

## Key Features

- Reads live campaign data from Facebook and Google Ads APIs
- Creates new campaigns, ad sets, and ads via API write operations
- LLM-powered intent parsing: translates business goals into API actions
- Structured output parsing for campaign data and performance summaries
- Budget adjustments and status changes via API

## Tech Stack

**Runtime:** Node.js | TypeScript

**AI/LLM:** OpenAI GPT-4 | Claude API | Anthropic SDK

**Integrations:** Facebook Marketing API v18+ | Google Ads API

**Auth:** OAuth 2.0 | Long-lived access tokens

**Storage:** Supabase (campaign snapshots + audit logs)

## Revenue Relevance

Reduces paid media management time, enables faster creative testing cycles, and allows non-technical operators to interact with ad platforms through structured commands and natural language.

## Security Note

No real ad account IDs, access tokens, or campaign data are included. See .env.example for all required variables.

## What This Proves to Hiring Teams

- API-connected agent architecture with both read and write operations
- LLM tool use and function calling patterns in production
- External API integration at the production workflow level
- Paid media workflow automation that saves real operator hours
