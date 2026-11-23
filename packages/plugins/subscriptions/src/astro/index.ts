/**
 * Astro component exports for the subscriptions plugin.
 *
 * Auto-wired via the `virtual:emdash/block-components` virtual module.
 */

import { SUBSCRIBE_BLOCK } from "../block.js";
export { hasSubscribeMarker, splitAtSubscribeMarkers, SUBSCRIBE_MARKER } from "../marker.js";
import SubscribeEmbed from "./SubscribeEmbed.astro";
export { default as SubscribeEmbed } from "./SubscribeEmbed.astro";

export const blockComponents = {
	[SUBSCRIBE_BLOCK]: SubscribeEmbed,
};
