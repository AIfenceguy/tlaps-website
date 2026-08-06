-- ============================================================================
-- CS bot — initial playbooks + routing rules
-- File: sql/11_cs_playbooks_seed.sql
-- Created: 2026-08-06
-- Spec: Hand-written starting rules so the bot can draft before the mined
--       binder exists. These get REPLACED/augmented by cs_sku_knowledge once
--       the mining job has run over closed tickets.
--
-- Routing recap (enforced in code, restated here for whoever reads this):
--   auto_draft  - order status, fitment CLARIFYING questions, product Q
--   human_only  - returns, refunds, money, damage, angry/escalated
--   no_draft    - eBay/Amazon platform cases (resolve in Seller Hub)
--
-- Run after sql/10_cs_bot_schema.sql.
-- ============================================================================

BEGIN;

INSERT INTO cs_playbooks (name, category, trigger_hint, instructions, marketplace) VALUES

('Order status — tracking exists',
 'order_status',
 'where is my order, has it shipped, tracking, when will it arrive',
 'The ticket fields already carry the answer — use them, do not ask the customer for the order number.
Quote the carrier, tracking number and ship date verbatim from the ticket fields.
If Latest Delivery Date is in the future, reassure and give that date. Do NOT offer a refund
or replacement at this stage; the order is simply in transit.
If the ship-by date has passed and there is no tracking, do not invent a reason — escalate.',
 NULL),

('Fitment — vehicle not specified',
 'fitment',
 'does this fit, will this work on my, compatible with',
 'NEVER state whether a part fits. You do not have authoritative fitment data.
If the ticket has a Buyer''s Vehicle field, restate it and confirm you are checking against it.
Otherwise ask the qualifying questions a good agent asks first:
  - exact year, make, model
  - cab and bed configuration (for trucks)
  - engine, if the listing is engine-specific
Close by saying you will confirm once you have those. This reply is a QUESTION, never an answer.',
 NULL),

('Fitment — customer says it does not fit',
 'fitment_dispute',
 'does not fit, doesn''t fit, wrong size, won''t line up, advertised wrong',
 'HUMAN ONLY. Do not draft a reply. These are one step from a return, a refund demand,
or a listing-accuracy complaint, and all three are the human''s call.
Flag for an agent with the SKU, the Buyer''s Vehicle, and the item title pulled out for them.',
 NULL),

('Install help — troubleshooting',
 'install',
 'can''t install, how do I install, instructions, bracket, hardware missing',
 'Diagnose before answering. Ask which step they are on, confirm the exact vehicle,
and request a photo of the current state. If cs_sku_knowledge has an entry for this SKU
matching their symptom, lead with that known cause and fix, then still ask for the photo
to confirm. Never guess at a fix for a SKU with no recorded history.',
 NULL),

('Product question — pre-purchase',
 'product_question',
 'what material, dimensions, does it come with, how many in a set',
 'Answer only from the item title, listing details and SKU data present on the ticket.
If the answer is not in what you were given, say you will confirm and escalate —
do not infer specifications from the product name.',
 NULL),

('Return or refund request',
 'return',
 'return, refund, money back, RMA, send it back',
 'HUMAN ONLY. Never draft. Money decisions belong to the human, always.
Surface the order ID, SKU, purchase date and order total so the agent can decide quickly.',
 NULL),

('Platform case — eBay/Amazon',
 'platform_case',
 'case opened, A-to-Z claim, item not received case, dispute, eBay case',
 'DO NOT DRAFT AN EMAIL REPLY. These are resolved in eBay Seller Hub or Amazon Seller Central,
not by replying to the notification. Replying here burns the response clock without
filing the actual case response. Flag it for an agent with a note saying where to go.',
 NULL),

('Amazon message constraints',
 'marketplace_rules',
 'applies to every Amazon reply',
 'Amazon Buyer-Seller Messaging forbids external links, email addresses, phone numbers,
and any attempt to move the conversation off-platform. Never include a URL in an Amazon reply.
Keep it under the 4000 character limit.',
 'Amazon')

ON CONFLICT (name) DO NOTHING;

COMMIT;

-- Verify: SELECT name, category FROM cs_playbooks ORDER BY category;
