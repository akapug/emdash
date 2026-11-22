import {
	contentProtectionSchema,
	createPasswordVerifier,
	PROTECTED_CONTENT_CAPABILITY,
	type ContentProtection,
} from "../content/protection.js";

export interface ProtectedImportOptions {
	protectedContent?: typeof PROTECTED_CONTENT_CAPABILITY;
	passwordSource?: "raw-wxr" | "redacted";
	protections?: Record<string, ContentProtection | { version: 1; mode: "redacted" }>;
}

export async function importProtection(
	post: { id?: number; postPassword?: string },
	options: ProtectedImportOptions,
): Promise<{ protected: boolean; protection?: ContentProtection; unrecoverable: boolean }> {
	const carried = options.protections?.[String(post.id)];
	const protectedPost = Boolean(post.postPassword) || carried !== undefined;
	if (!protectedPost) return { protected: false, unrecoverable: false };
	const portable = contentProtectionSchema.safeParse(carried);
	if (options.protectedContent === PROTECTED_CONTENT_CAPABILITY) {
		if (portable.success)
			return { protected: true, protection: portable.data, unrecoverable: false };
		if (carried === undefined && options.passwordSource === "raw-wxr" && post.postPassword) {
			return {
				protected: true,
				protection: {
					version: 1,
					mode: "password",
					verifier: await createPasswordVerifier(post.postPassword),
				},
				unrecoverable: false,
			};
		}
	}
	return {
		protected: true,
		unrecoverable: options.passwordSource === "redacted" || carried !== undefined,
	};
}
