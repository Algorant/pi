import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { RenderCache, renderCached } from "../core/render-cache";

export type FffToolKind = "find" | "grep";
const EMPTY: Component = { render: () => [], invalidate() {} };

type State = { kind: FffToolKind; args?: any; result?: AgentToolResult<any>; options?: ToolRenderResultOptions; error?: boolean; partial?: boolean };

export function createFffToolRenderer(kind: FffToolKind) {
  return {
    renderShell: "self" as const,
    renderCall(args: any, theme: Theme, context: any): Component { context.state.kind=kind; context.state.args=args; context.state.partial=!context.state.result; return new Card(context.state, theme); },
    renderResult(result: AgentToolResult<any>, options: ToolRenderResultOptions, _theme: Theme, context: any): Component { context.state.kind=kind; context.state.result=result; context.state.options=options; context.state.error=Boolean((result.details as any)?.error); return EMPTY; },
  };
}
class Card implements Component {
  private readonly cache = new RenderCache();
  constructor(private s: State, private t: Theme){}
  /** Pi's signal that cached output is stale, for example after a theme change. */
  invalidate(){ this.cache.clear(); }
  // The renderer state object is mutated in place by renderResult, so the cache
  // also compares the identity of every state field the card reads.
  render(width:number){ return renderCached(this.cache, width, this.t, (w)=>this.buildLines(w), [this.s.kind,this.s.args,this.s.result,this.s.options,this.s.error,this.s.partial]); }
  private buildLines(width:number){ const w=Math.max(1,width); if(w<8) return [truncateToWidth(`FFF ${this.s.kind}`,w,"…",true)]; const d=(this.s.result?.details||{}) as any, err=Boolean(this.s.error||d.error), partial=!this.s.result; const glyph=err?this.t.fg("error","✗"):partial?this.t.fg("accent","…"):this.t.fg("success","✓"); const title=`${glyph} ${this.t.fg("userMessageText",this.t.bold("FFF"))} ${this.t.fg("accent",this.t.bold(this.s.kind))}${chips(this.s.args,d,this.t)}`; const lines=[top(title,w,this.t,err)]; const add=(x="")=>lines.push(this.t.fg(err?"error":"borderMuted","│ ")+truncateToWidth(x,w-4,"…",true)+this.t.fg(err?"error":"borderMuted"," │")); if(err){add(this.t.fg("error",String(text(this.s.result)||d.error||"FFF error")));} else if(partial){add(this.t.fg("muted",`Searching ${this.s.args?.pattern||""}`));} else { if(d.externalSearch&&this.s.options?.expanded){add(this.t.fg("muted",`External root: ${d.externalSearch.root}`)); add(this.t.fg("dim",`Requested: ${d.externalSearch.requestedPath}${d.externalSearch.suffix?` · suffix=${d.externalSearch.suffix}`:""}`));} const body=text(this.s.result); const head=body.split("\n").slice(0,(this.s.options?.expanded?24:6)); for(const line of head.flatMap(l=>wrapTextWithAnsi(l,w-4))) add(line); if(d.nextCursor) add(this.t.fg("warning",`More results: cursor=${d.nextCursor}`)); if(d.weak) add(this.t.fg("warning","Weak/noisy fuzzy match; refine pattern.")); } lines.push(bottom(w,this.t,err)); return lines; }}
function text(r?:AgentToolResult<any>){return String(r?.content?.find((c:any)=>c.type==="text")?.text||"");}
function chips(a:any,d:any,t:Theme){const external=d?.externalSearch; const vals=[external&&"external",external?.root&&`root=${external.root}`,external?.created?"new index":external?.reused?"reused":null,external?.scanning&&"scanning",a?.pattern&&`pattern=${a.pattern}`,a?.path&&!external&&`path=${a.path}`,a?.limit&&`limit=${a.limit}`,a?.cursor&&`cursor=${a.cursor}`,a?.context&&`ctx=${a.context}`,d?.totalMatched!==undefined&&`${d.totalMatched} matches`].filter(Boolean); return vals.length?t.fg("dim",` · ${vals.join(" · ")}`):"";}
function top(title:string,w:number,t:Theme,err:boolean){const color=err?"error":"borderMuted", renderedTitle=truncateToWidth(` ${title} `,Math.max(1,w-6),"…"), fill=Math.max(0,w-3-visibleWidth(renderedTitle)); return t.fg(color,"╭─")+renderedTitle+t.fg(color,"─".repeat(fill)+"╮");}
function bottom(w:number,t:Theme,err:boolean){return t.fg(err?"error":"borderMuted","╰"+"─".repeat(Math.max(0,w-2))+"╯");}
