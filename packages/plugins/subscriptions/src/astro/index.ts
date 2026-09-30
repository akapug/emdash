/**
 * Astro component exports for the subscriptions plugin.
 *
 * Auto-wired via the `virtual:emdash/block-components` virtual module.
 */

import { SUBSCRIBE_BLOCK } from "../block.js";
import SubscribeEmbed from "./SubscribeEmbed.astro";

export const blockComponents = {
	[SUBSCRIBE_BLOCK]: SubscribeEmbed,
};
