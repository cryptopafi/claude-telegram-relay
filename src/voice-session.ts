/**
 * voice-session.ts
 * Session management for voice calls
 */

export interface CallSession {
  callControlId: string;
  phoneNumber: string;
  startTime: number;
  lastActivity: number;
  conversationHistory: ConversationMessage[];
  callDurationMs: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface DailyCallStats {
  [phoneNumber: string]: {
    count: number;
    lastReset: number;  // Timestamp of last daily reset
  };
}

/**
 * Session manager for active voice calls
 */
export class VoiceSessionManager {
  private activeSessions: Map<string, CallSession> = new Map();
  private dailyCallStats: DailyCallStats = {};

  /**
   * Check if a caller is allowed (allowlist check)
   */
  isCallerAllowed(phoneNumber: string, allowedCallers: string[]): boolean {
    // SECURITY FIX #5: Fail-closed - reject when allowlist is empty
    if (allowedCallers.length === 0) {
      console.warn('[SECURITY] Empty allowlist - rejecting all calls. Set VOICE_ALLOWED_CALLERS env var.');
      return false;
    }

    // Check if caller is in allowlist
    return allowedCallers.includes(phoneNumber);
  }

  /**
   * Check if caller has exceeded daily call limit
   */
  hasExceededDailyLimit(phoneNumber: string, maxDailyCalls: number): boolean {
    const now = Date.now();
    const stats = this.dailyCallStats[phoneNumber];

    if (!stats) {
      return false;
    }

    // Reset counter if it's a new day (24h since last reset)
    const dayInMs = 24 * 60 * 60 * 1000;
    if (now - stats.lastReset > dayInMs) {
      this.dailyCallStats[phoneNumber] = {
        count: 0,
        lastReset: now,
      };
      return false;
    }

    return stats.count >= maxDailyCalls;
  }

  /**
   * Increment daily call counter
   */
  incrementDailyCallCount(phoneNumber: string): void {
    const now = Date.now();

    if (!this.dailyCallStats[phoneNumber]) {
      this.dailyCallStats[phoneNumber] = {
        count: 1,
        lastReset: now,
      };
    } else {
      this.dailyCallStats[phoneNumber].count++;
    }
  }

  /**
   * Create a new call session
   */
  createSession(callControlId: string, phoneNumber: string): CallSession {
    const session: CallSession = {
      callControlId,
      phoneNumber,
      startTime: Date.now(),
      lastActivity: Date.now(),
      conversationHistory: [],
      callDurationMs: 0,
    };

    this.activeSessions.set(callControlId, session);
    this.incrementDailyCallCount(phoneNumber);

    return session;
  }

  /**
   * Get session by call control ID
   */
  getSession(callControlId: string): CallSession | undefined {
    return this.activeSessions.get(callControlId);
  }

  /**
   * Add message to conversation history
   */
  addMessage(callControlId: string, role: 'user' | 'assistant', content: string): void {
    const session = this.activeSessions.get(callControlId);
    if (!session) {
      return;
    }

    session.conversationHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Keep only last 20 exchanges (40 messages)
    if (session.conversationHistory.length > 40) {
      session.conversationHistory = session.conversationHistory.slice(-40);
    }

    session.lastActivity = Date.now();
  }

  /**
   * Get conversation history for Claude API
   */
  getConversationHistory(callControlId: string): Array<{role: string, content: string}> {
    const session = this.activeSessions.get(callControlId);
    if (!session) {
      return [];
    }

    return session.conversationHistory.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  /**
   * Update call duration
   */
  updateCallDuration(callControlId: string): void {
    const session = this.activeSessions.get(callControlId);
    if (!session) {
      return;
    }

    session.callDurationMs = Date.now() - session.startTime;
  }

  /**
   * Check if call has exceeded max duration
   */
  hasExceededMaxDuration(callControlId: string, maxDurationMinutes: number): boolean {
    const session = this.activeSessions.get(callControlId);
    if (!session) {
      return false;
    }

    this.updateCallDuration(callControlId);
    const maxDurationMs = maxDurationMinutes * 60 * 1000;

    return session.callDurationMs > maxDurationMs;
  }

  /**
   * End a call session
   */
  endSession(callControlId: string): CallSession | undefined {
    const session = this.activeSessions.get(callControlId);
    this.activeSessions.delete(callControlId);
    return session;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): CallSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get daily call stats for a phone number
   */
  getDailyStats(phoneNumber: string): { count: number; remaining: number } {
    const stats = this.dailyCallStats[phoneNumber];
    const maxDailyCalls = 50; // Default max

    if (!stats) {
      return { count: 0, remaining: maxDailyCalls };
    }

    return {
      count: stats.count,
      remaining: Math.max(0, maxDailyCalls - stats.count),
    };
  }

  /**
   * Clean up stale sessions (not active for > 5 minutes)
   */
  cleanupStaleSessions(): number {
    const now = Date.now();
    const staleThresholdMs = 5 * 60 * 1000; // 5 minutes
    let cleaned = 0;

    for (const [callControlId, session] of this.activeSessions.entries()) {
      if (now - session.lastActivity > staleThresholdMs) {
        this.activeSessions.delete(callControlId);
        cleaned++;
      }
    }

    return cleaned;
  }
}
