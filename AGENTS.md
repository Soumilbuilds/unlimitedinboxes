# Unlimited Inboxes Agent Instructions

## Product Design

- Preserve the existing black interface with restrained green-to-blue accents.
- Keep layouts symmetrical, spacious, responsive, and visually polished. Prefer quiet depth, crisp borders, and clear hierarchy over decorative clutter.
- Always Use Title Case For Customer-Facing Headings, Button Labels, Short Labels, Feature Names, And Compact Billing Terms. Capitalize The First Letter Of Every Word In These Elements. Use normal sentence case only for longer explanatory paragraphs, with every sentence properly capitalized and punctuated.
- Keep billing and upgrade experiences inside dedicated, polished application surfaces. Payment details must remain inside the payment processor's hosted or embedded secure checkout.

## Billing

- Whop is the active payment processor. xPay and Stripe are legacy compatibility code only and must not be used for new checkouts.
- Always prefill the authenticated user's email in Whop checkout and hide the email input while showing the email on the parent page.
- Prefill and hide the billing-address form only when a complete stored address is available. Otherwise leave Whop's address fields visible.
- Save payment methods for future off-session use through Whop; never collect, log, or persist raw card details.
- Verify Whop webhook signatures and make webhook processing idempotent before changing access.
- Use `Get Access` for the initial subscription checkout call to action.
