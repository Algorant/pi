import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export type WidgetSectionRenderContext = {
	width: number;
	theme: Theme;
};

export type WidgetSectionInteractiveContext = {
	tui: TUI;
	theme: Theme;
	requestRender: () => void;
	/** Focus the shared layout widget and route input to this section. */
	focus: () => void;
};

export type WidgetSectionComponent = Component & {
	dispose?(): void;
	focused?: boolean;
};

export type WidgetSection = {
	id: string;
	order: number;
	placement?: WidgetPlacement;
	visible?: () => boolean;
	render: (ctx: WidgetSectionRenderContext) => string[];
	/** Optional input-capable section mounted inside the shared layout widget. */
	interactive?: (ctx: WidgetSectionInteractiveContext) => WidgetSectionComponent;
};

type UiContext = Pick<ExtensionContext["ui"], "setWidget">;
export type WidgetLayoutContext = { ui: UiContext };
type WidgetCtx = WidgetLayoutContext;

type LayoutComponent = Component & {
	focused?: boolean;
	handleInput?(data: string): void;
	dispose?(): void;
};

type LayoutSlotState = {
	installed: boolean;
	requestRender?: () => void;
	sync?: () => void;
};

type LayoutState = {
	sections: Map<string, WidgetSection>;
	/** The TUI the layout widgets were mounted in, for focus queries. */
	tui?: TUI;
	slots: Record<WidgetPlacement, LayoutSlotState>;
};

const LAYOUT_STATE_KEY = Symbol.for("pi-ui.widget-layout.state");
const WIDGET_KEYS: Record<WidgetPlacement, string> = {
	aboveEditor: "pi-ui-layout:aboveEditor",
	belowEditor: "pi-ui-layout:belowEditor",
};
const LEGACY_WIDGET_KEYS = ["pi-todos"];

function layoutState(): LayoutState {
	const globalState = globalThis as typeof globalThis & { [LAYOUT_STATE_KEY]?: LayoutState };
	if (!globalState[LAYOUT_STATE_KEY]) {
		globalState[LAYOUT_STATE_KEY] = {
			sections: new Map(),
			slots: {
				aboveEditor: { installed: false },
				belowEditor: { installed: false },
			},
		};
	}
	return globalState[LAYOUT_STATE_KEY];
}

function placementOf(section: WidgetSection): WidgetPlacement {
	return section.placement ?? "aboveEditor";
}

function visibleSections(placement: WidgetPlacement): WidgetSection[] {
	return Array.from(layoutState().sections.values())
		.filter((section) => placementOf(section) === placement)
		.filter((section) => section.visible?.() ?? true)
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function renderLayout(placement: WidgetPlacement, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	for (const section of visibleSections(placement)) {
		const sectionLines = section.render({ width, theme }).filter((line) => line !== undefined);
		if (sectionLines.length === 0) continue;
		if (lines.length > 0) lines.push(" ");
		lines.push(...sectionLines);
	}
	if (lines.length === 0) return lines;
	// One blank line at the editor-facing edge, for every section registered
	// through this layout: below the widget area above the editor, above the
	// widget area below it.
	return placement === "aboveEditor" ? [...lines, " "] : [" ", ...lines];
}

function focusedComponentOf(tui: TUI): Component | null {
	const candidate = tui as TUI & { getFocusedComponent?: () => Component | null };
	return typeof candidate.getFocusedComponent === "function" ? candidate.getFocusedComponent() : null;
}

function ensureLayoutWidget(ctx: WidgetCtx, placement: WidgetPlacement): void {
	const state = layoutState();
	const slot = state.slots[placement];
	if (slot.installed) {
		slot.sync?.();
		slot.requestRender?.();
		return;
	}

	// One-shot migration cleanup from earlier standalone widget experiments. The
	// actual layout is owned by pi-ui under WIDGET_KEYS; feature extensions
	// must not continue to own these legacy above-editor widget keys.
	if (placement === "aboveEditor") {
		for (const key of LEGACY_WIDGET_KEYS) ctx.ui.setWidget(key, undefined);
	}

	ctx.ui.setWidget(WIDGET_KEYS[placement], (tui, theme) => {
		state.tui = tui;
		let layout!: LayoutComponent;
		let layoutFocused = false;
		let activeInteractiveId: string | undefined;
		let previousFocus: Component | null = null;
		const components = new Map<string, WidgetSectionComponent>();

		const syncFocus = () => {
			for (const [id, component] of components) {
				if ("focused" in component) component.focused = layoutFocused && id === activeInteractiveId;
			}
		};

		const focusSection = (id: string) => {
			if (focusedComponentOf(tui) !== layout) previousFocus = focusedComponentOf(tui);
			activeInteractiveId = id;
			tui.setFocus(layout);
			syncFocus();
			tui.requestRender();
		};

		const sync = () => {
			const current = new Map(visibleSections(placement).map((section) => [section.id, section]));
			for (const [id, component] of components) {
				const section = current.get(id);
				if (section?.interactive) continue;
				component.dispose?.();
				components.delete(id);
				if (activeInteractiveId === id) activeInteractiveId = undefined;
			}

			for (const section of current.values()) {
				if (!section.interactive || components.has(section.id)) continue;
				const component = section.interactive({
					tui,
					theme,
					requestRender: () => tui.requestRender(),
					focus: () => focusSection(section.id),
				});
				components.set(section.id, component);
			}

			syncFocus();
			if (!activeInteractiveId && layoutFocused && focusedComponentOf(tui) === layout) {
				tui.setFocus(previousFocus);
				previousFocus = null;
			}
		};

		layout = {
			get focused() {
				return layoutFocused;
			},
			set focused(value: boolean) {
				layoutFocused = value;
				syncFocus();
			},
			render: (width: number) => {
				sync();
				return renderLayout(placement, width, theme);
			},
			handleInput: (data: string) => {
				sync();
				if (!activeInteractiveId) return;
				components.get(activeInteractiveId)?.handleInput?.(data);
			},
			invalidate: () => {
				sync();
				for (const component of components.values()) component.invalidate();
			},
			dispose: () => {
				for (const component of components.values()) component.dispose?.();
				components.clear();
				if (focusedComponentOf(tui) === layout) tui.setFocus(previousFocus);
				previousFocus = null;
				activeInteractiveId = undefined;
				slot.installed = false;
				slot.requestRender = undefined;
				slot.sync = undefined;
			},
		};

		slot.requestRender = () => tui.requestRender();
		slot.sync = sync;
		sync();
		return layout;
	}, placement === "belowEditor" ? { placement: "belowEditor" } : undefined);
	slot.installed = true;
}

export function registerWidgetSection(ctx: WidgetCtx, section: WidgetSection): void {
	layoutState().sections.set(section.id, section);
	ensureLayoutWidget(ctx, placementOf(section));
	requestWidgetLayoutRender(ctx, placementOf(section));
}

export function unregisterWidgetSection(ctx: WidgetCtx, id: string): void {
	const previous = layoutState().sections.get(id);
	layoutState().sections.delete(id);
	if (previous) {
		const placement = placementOf(previous);
		layoutState().slots[placement].sync?.();
		requestWidgetLayoutRender(ctx, placement);
	}
}

/** The component that has keyboard focus now (the editor, a dock, a dialog), or null before a layout is mounted. */
export function focusedComponent(): Component | null {
	const tui = layoutState().tui;
	return tui ? focusedComponentOf(tui) : null;
}

export function requestWidgetLayoutRender(ctx: WidgetCtx, placement: WidgetPlacement = "aboveEditor"): void {
	ensureLayoutWidget(ctx, placement);
	layoutState().slots[placement].requestRender?.();
}

export function clearWidgetLayoutForReload(): void {
	const state = layoutState();
	state.sections.clear();
	for (const slot of Object.values(state.slots)) {
		slot.installed = false;
		slot.requestRender = undefined;
		slot.sync = undefined;
	}
}
