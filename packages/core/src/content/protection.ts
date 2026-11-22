import { z } from "zod";

export const PROTECTED_CONTENT_CAPABILITY = "emdash.protected-content.v1" as const;

export const passwordVerifierSchema = z
	.object({
		version: z.literal(1),
		algorithm: z.literal("pbkdf2-sha256"),
		iterations: z.literal(100000),
		salt: z.string().regex(/^[0-9a-f]{32}$/),
		hash: z.string().regex(/^[0-9a-f]{64}$/),
	})
	.strict();

export const contentProtectionSchema = z
	.object({
		version: z.literal(1),
		mode: z.literal("password"),
		verifier: passwordVerifierSchema,
	})
	.strict();

export type PasswordVerifier = z.infer<typeof passwordVerifierSchema>;
export type ContentProtection = z.infer<typeof contentProtectionSchema>;

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function unhex(value: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}
async function derive(password: string, salt: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", iterations: 100000, salt: unhex(salt) },
		key,
		256,
	);
	return hex(new Uint8Array(bits));
}

export async function createPasswordVerifier(password: string): Promise<PasswordVerifier> {
	if (password.length === 0) throw new Error("A protected page needs a nonempty password");
	const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
	return {
		version: 1,
		algorithm: "pbkdf2-sha256",
		iterations: 100000,
		salt,
		hash: await derive(password, salt),
	};
}

export async function verifyContentPassword(password: string, verifier: unknown): Promise<boolean> {
	const parsed = passwordVerifierSchema.safeParse(verifier);
	if (!parsed.success || password.length === 0) return false;
	const actual = unhex(await derive(password, parsed.data.salt));
	const expected = unhex(parsed.data.hash);
	let difference = 0;
	for (let index = 0; index < expected.length; index++)
		difference |= actual[index] ^ expected[index];
	return difference === 0;
}

/** Every schema field except the public title stays in the private payload, including custom SEO. */
export function protectedProjection(data: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(data).map(([key, value]) => [
			key,
			key === "title" || key === "_slug" || key === "_references" ? value : null,
		]),
	);
}
