import type { BrowserContext } from 'playwright';
import type { Logger } from './logger.js';

/**
 * Community posts that talk about a lesson, with their comments.
 *
 * Skool classroom lessons have no comment thread of their own; discussion
 * happens in community posts. Skool's search indexes the full post text, URLs
 * included. A lesson link is `/classroom/<courseKey>?md=<lessonId>`, so ONE
 * search per course for its key returns every post that links any lesson of
 * it. Each post (and its comments) is then attached to the lessons whose id it
 * contains.
 *
 * Searching per lesson instead (one request each, 8 lessons in parallel) trips
 * CloudFront's rate limit on www.skool.com within minutes: every request then
 * gets an HTML 403 "The request could not be satisfied" for several minutes.
 * So all requests go through one queue with a minimum gap, and a 403/429 backs
 * off and finally switches discussions off for the rest of the run.
 *
 * Endpoints (all authenticated with the saved session cookies):
 * - search:   www.skool.com/_next/data/<buildId>/<group>/-/search.json?group=<group>&q=<courseKey>&p=<n>
 *             (10 posts per page; consecutive pages can overlap, so posts are deduped by id)
 * - comments: api2.skool.com/posts/<postId>/comments?group-id=<groupId>&limit=25&pinned=true
 *             then &created-gt=<last>&limit=25 until `last` stops moving. limit > 25 is
 *             rejected ("invalid limit"). Replies come nested in `children` (two levels).
 */

export type DiscussionComment = {
    id: string;
    authorName: string;
    authorHandle?: string;
    createdAt?: string;
    content: string;
    upvotes: number;
    replies: DiscussionComment[];
};

export type Discussion = {
    id: string;
    url: string;
    title: string;
    authorName: string;
    authorHandle?: string;
    createdAt?: string;
    content: string;
    upvotes: number;
    commentsCount: number;
    comments: DiscussionComment[];
    /** Set when the comments could not be fetched completely. */
    commentsError?: string;
};

const MAX_SEARCH_PAGES = 30; // 300 posts linking one course
const MAX_COMMENT_PAGES = 40; // 40 × 25 = 1000 top-level comments per post
const MIN_GAP_MS = 1200;
const BACKOFF_MS = [30_000, 90_000];

export class DiscussionFetcher {
    private buildIds = new Map<string, Promise<string>>();
    private courseScans = new Map<string, Promise<Discussion[]>>();
    private queue: Promise<unknown> = Promise.resolve();
    private lastRequestAt = 0;
    private disabledReason?: string;
    private getContext: () => Promise<BrowserContext>;
    private logger: Logger;

    constructor(getContext: () => Promise<BrowserContext>, logger: Logger) {
        this.getContext = getContext;
        this.logger = logger;
    }

    /**
     * GET through a single serialized queue, at most one request per MIN_GAP_MS.
     * 403/429 (CloudFront rate limit) wait and retry; if it persists, every
     * later call fails fast instead of extending the block.
     */
    private get(url: string): Promise<any> {
        const run = async () => {
            if (this.disabledReason) throw new Error(this.disabledReason);
            const ctx = await this.getContext();
            for (let attempt = 0; ; attempt++) {
                const wait = this.lastRequestAt + MIN_GAP_MS - Date.now();
                if (wait > 0) await sleep(wait);
                this.lastRequestAt = Date.now();
                const res = await ctx.request.get(url);
                if (res.ok()) {
                    const type = res.headers()['content-type'] ?? '';
                    return type.includes('json') ? res.json() : res.text();
                }
                const status = res.status();
                if ((status === 403 || status === 429) && attempt < BACKOFF_MS.length) {
                    this.logger.warn(`    ⏳ Skool rate limit (HTTP ${status}), waiting ${BACKOFF_MS[attempt] / 1000}s...`);
                    await sleep(BACKOFF_MS[attempt]);
                    continue;
                }
                if (status === 403 || status === 429) {
                    this.disabledReason = `Skool rate limit (HTTP ${status}); discussions skipped for the rest of this run`;
                    throw new Error(this.disabledReason);
                }
                throw new Error(`HTTP ${status}: ${(await res.text()).slice(0, 100)}`);
            }
        };
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => undefined);
        return result;
    }

    /** Next.js build id, needed for the `_next/data` routes. Fetched once per group. */
    private buildId(group: string): Promise<string> {
        let pending = this.buildIds.get(group);
        if (!pending) {
            pending = (async () => {
                const html = String(await this.get(`https://www.skool.com/${group}`));
                const id = html.match(/"buildId":"([^"]+)"/)?.[1];
                if (!id) throw new Error('Skool buildId not found');
                return id;
            })();
            pending.catch(() => this.buildIds.delete(group));
            this.buildIds.set(group, pending);
        }
        return pending;
    }

    /**
     * Posts (with comments) that mention this lesson: its id appears in the
     * post text or in any of its comments. Lessons of one course share a
     * single scan, so a course costs a handful of search requests.
     */
    async fetchForLesson(lessonUrl: string, lessonId: string): Promise<Discussion[]> {
        const group = groupFromUrl(lessonUrl);
        const courseKey = courseKeyFromUrl(lessonUrl);
        if (!group || !courseKey) return [];

        const scanKey = `${group}/${courseKey}`;
        let scan = this.courseScans.get(scanKey);
        if (!scan) {
            scan = this.scanCourse(group, courseKey);
            scan.catch(() => this.courseScans.delete(scanKey));
            this.courseScans.set(scanKey, scan);
        }
        const all = await scan;
        return all.filter(d => mentions(d, lessonId));
    }

    private async scanCourse(group: string, courseKey: string): Promise<Discussion[]> {
        const build = await this.buildId(group);

        const posts = new Map<string, any>();
        for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
            const url = `https://www.skool.com/_next/data/${build}/${group}/-/search.json`
                + `?group=${encodeURIComponent(group)}&q=${encodeURIComponent(courseKey)}&p=${page}`;
            const props = (await this.get(url))?.pageProps ?? {};
            for (const tree of props.postTrees ?? []) {
                if (tree?.post?.id) posts.set(tree.post.id, tree.post);
            }
            if (page >= (props.totalPostPages ?? 1)) break;
        }

        const discussions: Discussion[] = [];
        for (const post of posts.values()) {
            const meta = post.metadata ?? {};
            const discussion: Discussion = {
                id: post.id,
                url: `https://www.skool.com/${group}/${post.name}`,
                title: meta.title || '(untitled post)',
                authorName: userName(post.user),
                authorHandle: post.user?.name,
                createdAt: post.createdAt ?? post.created_at,
                content: meta.content ?? '',
                upvotes: meta.upvotes ?? 0,
                commentsCount: meta.comments ?? 0,
                comments: []
            };
            if (discussion.commentsCount > 0) {
                try {
                    discussion.comments = await this.fetchComments(post.id, post.groupId ?? post.group_id);
                } catch (err) {
                    discussion.commentsError = String(err).slice(0, 300);
                    this.logger.warn(`    ⚠️ Could not fetch comments of post "${discussion.title}": ${discussion.commentsError}`);
                }
            }
            discussions.push(discussion);
        }

        // Oldest first, like reading the conversation in order.
        discussions.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
        return discussions;
    }

    private async fetchComments(postId: string, groupId: string): Promise<DiscussionComment[]> {
        const seen = new Set<string>();
        const comments: DiscussionComment[] = [];
        const base = `https://api2.skool.com/posts/${postId}/comments?group-id=${groupId}&limit=25`;
        let cursor: string | number | undefined;

        for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
            const url = cursor === undefined ? `${base}&pinned=true` : `${base}&created-gt=${cursor}`;
            const data = await this.get(url);
            const trees = [
                ...(data?.pinned_post_tree?.children ?? []),
                ...(data?.post_tree?.children ?? [])
            ];
            let added = 0;
            for (const tree of trees) {
                const id = tree?.post?.id;
                if (!id || seen.has(id)) continue;
                seen.add(id);
                comments.push(toComment(tree));
                added++;
            }
            if (!data?.last || data.last === cursor || added === 0) break;
            cursor = data.last;
        }

        comments.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
        return comments;
    }
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** True when the lesson id appears in the post text or any comment/reply. */
function mentions(d: Discussion, lessonId: string): boolean {
    if (d.content.includes(lessonId)) return true;
    const inComments = (list: DiscussionComment[]): boolean =>
        list.some(c => c.content.includes(lessonId) || inComments(c.replies));
    return inComments(d.comments);
}

function toComment(tree: any): DiscussionComment {
    const post = tree.post ?? {};
    const replies = (tree.children ?? []).map(toComment);
    replies.sort((a: DiscussionComment, b: DiscussionComment) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    return {
        id: post.id,
        authorName: userName(post.user),
        authorHandle: post.user?.name,
        createdAt: post.created_at ?? post.createdAt,
        content: post.metadata?.content ?? '',
        upvotes: post.metadata?.upvotes ?? 0,
        replies
    };
}

function userName(user: any): string {
    if (!user) return 'Unknown';
    const first = user.firstName ?? user.first_name ?? '';
    const last = user.lastName ?? user.last_name ?? '';
    return `${first} ${last}`.trim() || user.name || 'Unknown';
}

/** `https://www.skool.com/<group>/classroom/<courseKey>?md=…` → `<courseKey>` */
export function courseKeyFromUrl(url: string): string | undefined {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        const i = parts.indexOf('classroom');
        return i >= 0 ? parts[i + 1] : undefined;
    } catch {
        return undefined;
    }
}

export function groupFromUrl(url: string): string | undefined {
    try {
        return new URL(url).pathname.split('/').filter(Boolean)[0];
    } catch {
        return undefined;
    }
}

export function countComments(discussions: Discussion[]): number {
    const count = (list: DiscussionComment[]): number => list.reduce((n, c) => n + 1 + count(c.replies), 0);
    return discussions.reduce((n, d) => n + count(d.comments), 0);
}

function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Skool post text is plain text with Markdown-style links: `[label](https://…)`.
 * Mentions use `[@Name](obj://user/<id>)` and are shown as plain `@Name`.
 */
function renderText(raw: string): string {
    // Skool stores Markdown-escaped punctuation: "\\(literally\\)".
    const text = raw.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1');
    const parts: string[] = [];
    const link = /\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()"]+)/g;
    let last = 0;
    for (const m of text.matchAll(link)) {
        parts.push(escapeHtml(text.slice(last, m.index)));
        const [whole, label, target, bare] = m;
        const href = bare ?? target;
        if (/^https?:\/\//i.test(href)) {
            parts.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label ?? href)}</a>`);
        } else {
            parts.push(escapeHtml(label ?? whole));
        }
        last = (m.index ?? 0) + whole.length;
    }
    parts.push(escapeHtml(text.slice(last)));
    return parts.join('').replace(/\r?\n/g, '<br>');
}

function formatDate(iso?: string) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function renderComment(c: DiscussionComment): string {
    return `
        <li class="comment">
            <div class="comment-meta"><strong>${escapeHtml(c.authorName)}</strong> · ${formatDate(c.createdAt)}${c.upvotes ? ` · 👍 ${c.upvotes}` : ''}</div>
            <div class="comment-body">${renderText(c.content)}</div>
            ${c.replies.length ? `<ul class="replies">${c.replies.map(renderComment).join('')}</ul>` : ''}
        </li>`;
}

export const DISCUSSIONS_CSS = `
    .discussions { margin-top: 28px; }
    .discussion { background: var(--panel-2, #f6f7fb); border-radius: 14px; padding: 16px 18px; margin: 14px 0; }
    .discussion > summary { cursor: pointer; font-weight: 600; }
    .discussion .post-meta, .comment-meta { color: var(--muted, #5b6271); font-size: 0.9em; margin: 6px 0; }
    .discussion .post-body { margin: 10px 0 14px; }
    .discussions a { display: inline; padding: 0; background: none; border: 0; box-shadow: none; color: var(--accent, #3b82f6); overflow-wrap: anywhere; }
    .discussions a::before { content: none; }
    .discussions .comments, .discussions .replies { list-style: none; padding: 0; margin: 0; display: block; }
    .discussions .replies { padding-left: 22px; border-left: 3px solid var(--ring, rgba(20,22,29,0.12)); margin: 8px 0 0 4px; }
    .comment { padding: 8px 0; border-top: 1px solid var(--ring, rgba(20,22,29,0.08)); }
    .comment-body { white-space: normal; overflow-wrap: anywhere; }
`;

export function renderDiscussions(discussions: Discussion[]): string {
    if (discussions.length === 0) return '';
    const total = countComments(discussions);
    const items = discussions.map(d => `
        <details class="discussion">
            <summary>${escapeHtml(d.title)} <span class="post-meta">· ${d.comments.length ? `${countComments([d])} comments` : 'no comments'}</span></summary>
            <div class="post-meta">${escapeHtml(d.authorName)} · ${formatDate(d.createdAt)}${d.upvotes ? ` · 👍 ${d.upvotes}` : ''} · <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">View on Skool</a></div>
            <div class="post-body">${renderText(d.content)}</div>
            ${d.commentsError ? `<p class="post-meta">⚠️ Comments incomplete: ${escapeHtml(d.commentsError)}</p>` : ''}
            ${d.comments.length ? `<ul class="comments">${d.comments.map(renderComment).join('')}</ul>` : ''}
        </details>`).join('');
    return `
        <div class="resources discussions">
            <h3>Community Discussions (${discussions.length} posts · ${total} comments)</h3>
            ${items}
        </div>`;
}
