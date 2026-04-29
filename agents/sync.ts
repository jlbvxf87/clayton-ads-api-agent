import 'dotenv/config';
import { supabase } from './supabase.js';
import {
  listCampaigns,
  getCampaignInsights,
  extractLeads,
  type Campaign,
  type CampaignInsight,
} from './meta.js';

const ACCOUNT_ID = process.env.META_AD_ACCOUNT!;

async function snapshot(): Promise<void> {
  const [campaigns, todayInsights, yesterdayInsights] = await Promise.all([
    listCampaigns(),
    getCampaignInsights('today'),
    getCampaignInsights('yesterday'),
  ]);

  const todayByCampaign = new Map<string, CampaignInsight>();
  for (const i of todayInsights) todayByCampaign.set(i.campaign_id, i);
  const yesterdayByCampaign = new Map<string, CampaignInsight>();
  for (const i of yesterdayInsights) yesterdayByCampaign.set(i.campaign_id, i);

  const rows = campaigns.map((c: Campaign) => {
    const t = todayByCampaign.get(c.id);
    const y = yesterdayByCampaign.get(c.id);
    return {
      account_id: ACCOUNT_ID,
      campaign_id: c.id,
      campaign_name: c.name,
      status: c.effective_status ?? c.status,
      daily_budget_cents: c.daily_budget ? Number(c.daily_budget) : null,
      lifetime_budget_cents: c.lifetime_budget ? Number(c.lifetime_budget) : null,
      objective: c.objective ?? null,
      spend_today_cents: t?.spend ? Math.round(Number(t.spend) * 100) : 0,
      leads_today: t ? extractLeads(t) : 0,
      impressions_today: t?.impressions ? Number(t.impressions) : 0,
      clicks_today: t?.clicks ? Number(t.clicks) : 0,
      ctr_today: t?.ctr ? Number(t.ctr) : null,
      cpc_today: t?.cpc ? Number(t.cpc) : null,
      cpm_today: t?.cpm ? Number(t.cpm) : null,
      spend_yesterday_cents: y?.spend ? Math.round(Number(y.spend) * 100) : 0,
      leads_yesterday: y ? extractLeads(y) : 0,
      raw: { campaign: c, today: t ?? null, yesterday: y ?? null },
    };
  });

  if (rows.length === 0) {
    console.log('No campaigns to snapshot.');
    return;
  }

  const { error } = await supabase.from('campaign_snapshots').insert(rows);
  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  console.log(`Snapshotted ${rows.length} campaigns at ${new Date().toISOString()}`);
}

snapshot().catch((err) => {
  console.error('Snapshot failed:', err);
  process.exit(1);
});
