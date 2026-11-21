import { describe, it, expect } from 'vitest';
import { botDetailsView } from '../src/views.js';
import { appendBotDecision } from '../src/botLogic.js';

// Master Vision Phase 3: Admin decision history + memory viewer grouped
// by category.
const bot = {
  id: 'bot_nova', name: 'Nova', username: 'nova.bot', avatar: '', bio: 'AI Bot', active: true,
  provider: '', model: '',
  personality: { traits: ['curious'], tone: 'bright', interests: ['space'], systemPrompt: 'You are Nova.' },
  limits: { postsPerDay: 3, commentsPerDay: 10, likesPerDay: 20, messagesPerDay: 5, minIntervalMs: 900000 },
  createdAt: 1
};
const dataset = {
  bots: [bot],
  users: [{ id: 'bot_nova', name: 'Nova', username: 'nova.bot', avatar: '' }],
  botBrains: {},
  botSettings: { counters: {}, global: { enabled: true } },
  botMemories: {
    bot_nova: [
      { id: 'm1', text: 'Talked with Hasan about Mars.', category: 'conversation', createdAt: 1, updatedAt: 1, pinned: false },
      { id: 'm2', text: 'Loves black holes.', category: 'interest', createdAt: 1, updatedAt: 1, pinned: false },
      { id: 'm3', text: 'Old note without a category.', createdAt: 1, updatedAt: 1, pinned: false }
    ]
  },
  botDecisions: {
    bot_nova: [
      { action: 'post', reason: 'via openrouter', at: Date.now() - 60_000 },
      { action: 'none', reason: 'decided to wait this cycle (personality pacing)', at: Date.now() }
    ]
  },
  posts: [], messages: [], conversations: [], botActivities: [], botLogs: [], notifications: [], reports: []
};

describe('Phase 3 admin views', () => {
  it('memory tab groups memories by category with counts', () => {
    const html = botDetailsView(dataset, { id: 'admin1', role: 'superadmin' }, 'bot_nova', 'memory');
    expect(html).toContain('From conversations (1)');
    expect(html).toContain('Interests (1)');
    expect(html).toContain('General (1)');
    expect(html).toContain('Talked with Hasan about Mars.');
    expect(html).toContain('bot-memory-delete');
  });
  it('activity tab shows the persisted decision history, newest first', () => {
    const html = botDetailsView(dataset, { id: 'admin1', role: 'superadmin' }, 'bot_nova', 'activity');
    expect(html).toContain('Decision history');
    expect(html).toContain('personality pacing');
    expect(html.indexOf('personality pacing')).toBeLessThan(html.indexOf('via openrouter'));
  });
});

describe('appendBotDecision', () => {
  it('shapes, timestamps and caps the history at 50', () => {
    let items = [];
    for (let i = 0; i < 55; i++) items = appendBotDecision(items, { action: 'post', reason: `r${i}`, at: 1000 + i });
    expect(items).toHaveLength(50);
    expect(items[0].reason).toBe('r5');
    expect(items[49].reason).toBe('r54');
  });
  it('defaults the action and truncates long reasons', () => {
    const [entry] = appendBotDecision([], { reason: 'x'.repeat(300), at: 5 });
    expect(entry.action).toBe('none');
    expect(entry.reason).toHaveLength(200);
    expect(entry.at).toBe(5);
  });
});
