import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { PickedContentEntry } from "../../../src/components/ContentPickerModal";
import type {
	ContentItem,
	MediaItem,
	SiteSettings,
	SiteSettingsUpdate,
} from "../../../src/lib/api";
import { render } from "../../utils/render";

const mockFetchSettings = vi.fn<() => Promise<Partial<SiteSettings>>>();
const mockUpdateSettings =
	vi.fn<(settings: SiteSettingsUpdate) => Promise<Partial<SiteSettings>>>();
const mockFetchContent = vi.fn<(collection: string, id: string) => Promise<ContentItem>>();

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
	};
});

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return {
		...actual,
		fetchSettings: () => mockFetchSettings(),
		updateSettings: (settings: SiteSettingsUpdate) => mockUpdateSettings(settings),
		fetchContent: (collection: string, id: string) => mockFetchContent(collection, id),
		fetchManifest: async () => ({ collections: {} }),
	};
});

vi.mock("../../../src/components/ContentPickerModal", () => ({
	ContentPickerModal: ({
		open,
		title,
		onConfirm,
		onOpenChange,
	}: {
		open: boolean;
		title?: string;
		onConfirm: (entries: PickedContentEntry[]) => void;
		onOpenChange: (open: boolean) => void;
	}) => {
		if (!open) return null;
		return (
			<div role="dialog" aria-label={title}>
				<button
					type="button"
					onClick={() => {
						onConfirm([
							{ collection: "pages", id: "page_about", slug: "about", title: "About us" },
						]);
						onOpenChange(false);
					}}
				>
					Choose About us
				</button>
			</div>
		);
	},
}));

vi.mock("../../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({
		open,
		title,
		onSelect,
	}: {
		open: boolean;
		title: React.ReactNode;
		onSelect: (media: MediaItem) => void;
	}) => {
		if (!open) return null;
		const modalTitle = typeof title === "string" ? title : "";
		const isLogo = modalTitle === "Select logo";
		return (
			<div role="dialog" aria-label={modalTitle}>
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: isLogo ? "new-logo" : "new-favicon",
							filename: isLogo ? "logo.png" : "favicon.png",
							mimeType: "image/png",
							url: isLogo ? "/media/logo.png" : "/media/favicon.png",
							alt: isLogo ? "Replacement logo" : "",
							provider: "local",
							storageKey: isLogo ? "logo.png" : "favicon.png",
							size: 1,
							createdAt: "2026-01-01T00:00:00.000Z",
						})
					}
				>
					Choose image
				</button>
			</div>
		);
	},
}));

const { GeneralSettings } = await import("../../../src/components/settings/GeneralSettings");

const defaultSettings: Partial<SiteSettings> = {
	title: "My Blog",
	tagline: "Thoughts on building for the web",
	url: "https://example.com",
	postsPerPage: 10,
	dateFormat: "MMMM d, yyyy",
	timezone: "UTC",
	social: { github: "https://github.com/example" },
};

function Wrapper({ children }: { children: React.ReactNode }) {
	return <Toasty>{children}</Toasty>;
}

async function renderGeneralSettings() {
	return render(<GeneralSettings />, { wrapper: Wrapper });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchSettings.mockResolvedValue(defaultSettings);
	mockUpdateSettings.mockImplementation(async (settings) => {
		mockFetchSettings.mockResolvedValue(settings);
		return settings;
	});
});

describe("GeneralSettings", () => {
	it("shows the shared frame while settings load", async () => {
		mockFetchSettings.mockReturnValue(new Promise(() => undefined));
		const screen = await renderGeneralSettings();

		await expect
			.element(screen.getByRole("heading", { name: "General Settings", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading settings...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("shows a load failure without form actions", async () => {
		mockFetchSettings.mockRejectedValue(new Error("Settings service unavailable"));
		const screen = await renderGeneralSettings();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("An error occurred");
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Settings service unavailable");
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("renders grouped fields with both save actions initially disabled", async () => {
		const screen = await renderGeneralSettings();

		await expect.element(screen.getByLabelText("Site Title")).toHaveValue("My Blog");
		await expect
			.element(screen.getByRole("heading", { name: "Site Identity", level: 2 }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("heading", { name: "Reading", level: 2 }))
			.toBeInTheDocument();

		const saveButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(saveButtons).toHaveLength(2);
		for (const button of saveButtons) await expect.element(button).toBeDisabled();
	});

	it("enables both save actions when dirty and returns to saved after success", async () => {
		const screen = await renderGeneralSettings();
		await screen.getByLabelText("Site Title").fill("A better blog");

		const dirtyButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(dirtyButtons).toHaveLength(2);
		for (const button of dirtyButtons) await expect.element(button).toBeEnabled();

		await userEvent.click(dirtyButtons[0]);
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith({
				...defaultSettings,
				title: "A better blog",
			});
		});
		await expect.element(screen.getByText("Settings saved successfully")).toBeInTheDocument();

		const savedButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(savedButtons).toHaveLength(2);
		for (const button of savedButtons) await expect.element(button).toBeDisabled();
	});

	it("keeps cached settings visible when the post-save refetch fails", async () => {
		mockUpdateSettings.mockImplementation(async (settings) => {
			mockFetchSettings.mockRejectedValue(new Error("Settings refetch failed"));
			return settings;
		});
		const screen = await renderGeneralSettings();
		await screen.getByLabelText("Site Title").fill("A better blog");

		await screen.getByRole("button", { name: "Save", exact: true }).first().click();

		await vi.waitFor(() => expect(mockFetchSettings.mock.calls.length).toBeGreaterThanOrEqual(2));
		await expect.element(screen.getByLabelText("Site Title")).toHaveValue("A better blog");
		expect(screen.getByRole("alert").query()).toBeNull();
	});

	it("keeps the form dirty and reports a failed save", async () => {
		mockUpdateSettings.mockRejectedValue(new Error("Could not persist settings"));
		const screen = await renderGeneralSettings();
		await screen.getByLabelText("Tagline").fill("A changed tagline");

		await screen.getByRole("button", { name: "Save", exact: true }).first().click();
		await expect.element(screen.getByText("Failed to save settings")).toBeInTheDocument();
		await expect.element(screen.getByText("Could not persist settings")).toBeInTheDocument();

		const dirtyButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(dirtyButtons).toHaveLength(2);
		for (const button of dirtyButtons) await expect.element(button).toBeEnabled();
	});

	it("marks media selections dirty and includes them in the saved settings", async () => {
		const screen = await renderGeneralSettings();

		await userEvent.click(screen.getByRole("button", { name: "Select Logo" }));
		await userEvent.click(screen.getByRole("button", { name: "Choose image" }));
		await expect.element(screen.getByRole("img", { name: "Replacement logo" })).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Select Favicon" }));
		await userEvent.click(screen.getByRole("button", { name: "Choose image" }));
		await screen.getByRole("button", { name: "Save", exact: true }).first().click();

		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					logo: {
						mediaId: "new-logo",
						alt: "Replacement logo",
						url: "/media/logo.png",
					},
					favicon: { mediaId: "new-favicon", url: "/media/favicon.png" },
				}),
			);
		});
	});

	it("allows existing logo and favicon references to be removed", async () => {
		mockFetchSettings.mockResolvedValue({
			...defaultSettings,
			logo: { mediaId: "old-logo", alt: "Old logo", url: "/media/old-logo.png" },
			favicon: { mediaId: "old-favicon", url: "/media/old-favicon.png" },
		});
		const screen = await renderGeneralSettings();
		await expect.element(screen.getByRole("img", { name: "Old logo" })).toBeInTheDocument();

		const removeButtons = screen.getByRole("button", { name: "Remove" }).all();
		expect(removeButtons).toHaveLength(2);
		await userEvent.click(removeButtons[0]);
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));

		await expect.element(screen.getByRole("button", { name: "Select Logo" })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Select Favicon" }))
			.toBeInTheDocument();
		for (const button of screen.getByRole("button", { name: "Save", exact: true }).all()) {
			await expect.element(button).toBeEnabled();
		}

		await screen.getByRole("button", { name: "Save", exact: true }).first().click();
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith(
				expect.objectContaining({ logo: null, favicon: null }),
			);
		});
	});

	it("saves a chosen page as the homepage", async () => {
		const screen = await renderGeneralSettings();
		await expect.element(screen.getByRole("radio", { name: "Latest posts" })).toBeChecked();

		await screen.getByText("A page", { exact: true }).click();
		await screen.getByRole("button", { name: "Choose About us" }).click();

		await expect.element(screen.getByRole("radio", { name: "A page" })).toBeChecked();
		await expect.element(screen.getByText("About us")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Save", exact: true }).first().click();
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith(
				expect.objectContaining({ homepage: { collection: "pages", id: "page_about" } }),
			);
		});
	});

	it("shows the saved homepage and switches back to the latest posts", async () => {
		mockFetchSettings.mockResolvedValue({
			...defaultSettings,
			homepage: {
				collection: "pages",
				id: "page_about",
				entry: { id: "page_about", locale: "en", status: "published" },
			},
		});
		mockFetchContent.mockResolvedValue({
			id: "page_about",
			slug: "about",
			data: { title: "About us" },
		} as ContentItem);
		const screen = await renderGeneralSettings();

		await expect.element(screen.getByText("About us")).toBeInTheDocument();
		expect(mockFetchContent).toHaveBeenCalledWith("pages", "page_about");

		await screen.getByText("Latest posts", { exact: true }).click();
		await expect.element(screen.getByText("About us")).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Save", exact: true }).first().click();
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({ homepage: null }));
		});
	});

	it("says when the saved homepage entry no longer exists", async () => {
		mockFetchSettings.mockResolvedValue({
			...defaultSettings,
			homepage: { collection: "pages", id: "page_gone", entry: null },
		});
		const screen = await renderGeneralSettings();

		await expect
			.element(screen.getByText(/The chosen page is no longer available/))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Change page" })).toBeInTheDocument();
		expect(mockFetchContent).not.toHaveBeenCalled();
	});

	it("shows the translation the site renders once the original is gone", async () => {
		mockFetchSettings.mockResolvedValue({
			...defaultSettings,
			homepage: {
				collection: "pages",
				id: "group_about",
				entry: { id: "page_about_es", locale: "es", status: "published" },
			},
		});
		mockFetchContent.mockResolvedValue({
			id: "page_about_es",
			slug: "sobre",
			data: { title: "Sobre nosotros" },
		} as ContentItem);
		const screen = await renderGeneralSettings();

		await expect.element(screen.getByText("Sobre nosotros")).toBeInTheDocument();
		expect(mockFetchContent).toHaveBeenCalledWith("pages", "page_about_es");
		await expect
			.element(screen.getByText(/The chosen page is no longer available/))
			.not.toBeInTheDocument();
	});

	it("marks a homepage that is not published", async () => {
		mockFetchSettings.mockResolvedValue({
			...defaultSettings,
			homepage: {
				collection: "pages",
				id: "page_about",
				entry: { id: "page_about", locale: "en", status: "draft" },
			},
		});
		mockFetchContent.mockResolvedValue({
			id: "page_about",
			slug: "about",
			data: { title: "About us" },
		} as ContentItem);
		const screen = await renderGeneralSettings();

		await expect.element(screen.getByText("About us")).toBeInTheDocument();
		await expect.element(screen.getByText("Draft", { exact: true })).toBeInTheDocument();
	});
});
