/**
 * voice-emergency.ts
 * Emergency phrase detection and alert system
 */

/**
 * Emergency phrases with severity tiers
 * Critical = Immediate life threat, High = Urgent medical, Medium = Needs help
 */
const EMERGENCY_PHRASES = {
  romanian: {
    critical: [
      '112', 'ambulanta', 'ambulanță', 'suna la ambulanta', 'sună la ambulanță',
      'nu pot respira', 'nu pot să respir', 'infarct', 'cheama salvarea', 'cheamă salvarea',
    ],
    high: [
      'urgenta', 'urgență', 'ajutor urgent', 'am cazut', 'am căzut',
      'sangerare', 'sângerare', 'accident grav',
    ],
    medium: [
      'ajutor', 'ma simt rau', 'mă simt rău', 'durere puternica', 'durere puternică',
      'ma doare foarte tare', 'mă doare foarte tare',
    ],
  },
  english: {
    critical: [
      'call 112', 'call 911', 'ambulance', "can't breathe", 'heart attack',
    ],
    high: [
      'emergency', 'i fell', 'bleeding', 'stroke', 'help me',
    ],
    medium: [
      'help', 'i feel sick', 'chest pain',
    ],
  },
};

/**
 * Emergency response messages
 */
const EMERGENCY_RESPONSES = {
  romanian: `Am detectat o urgență. Trimit imediat alertă pe Telegram.
Dacă este o urgență medicală gravă, te rog sună imediat la 112.
Rămân la telefon cu tine.`,

  english: `I detected an emergency. I'm immediately sending an alert on Telegram.
If this is a serious medical emergency, please call 112 immediately.
I'll stay on the line with you.`,

  romanianConfirmation: `Am detectat că ai nevoie de ajutor. Este o urgență sau pot să te ajut cu altceva?`,
  englishConfirmation: `I detected you need help. Is this an emergency or can I help you with something else?`,
};

export interface EmergencyDetectionResult {
  isEmergency: boolean;
  severity: 'critical' | 'high' | 'medium' | 'none';
  detectedPhrases: string[];
  language: 'romanian' | 'english' | 'unknown';
  requiresConfirmation: boolean;
}

/**
 * Escape HTML for Telegram messages
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Detect emergency phrases in text
 * H-1 AUDIT FIX: ALWAYS check critical phrases from BOTH languages
 */
export function detectEmergency(text: string): EmergencyDetectionResult {
  const lowerText = text.toLowerCase();
  const detectedPhrases: string[] = [];
  let language: 'romanian' | 'english' | 'unknown' = 'unknown';
  let severity: 'critical' | 'high' | 'medium' | 'none' = 'none';

  // ALWAYS check ALL critical phrases from BOTH languages
  for (const phrase of EMERGENCY_PHRASES.romanian.critical) {
    if (lowerText.includes(phrase)) {
      detectedPhrases.push(phrase);
      language = 'romanian';
      severity = 'critical';
    }
  }
  for (const phrase of EMERGENCY_PHRASES.english.critical) {
    if (lowerText.includes(phrase)) {
      detectedPhrases.push(phrase);
      if (language === 'unknown') language = 'english';
      severity = 'critical';
    }
  }

  // Check high only if not already critical
  if (severity !== 'critical') {
    for (const phrase of EMERGENCY_PHRASES.romanian.high) {
      if (lowerText.includes(phrase)) {
        detectedPhrases.push(phrase);
        language = 'romanian';
        severity = 'high';
      }
    }
    for (const phrase of EMERGENCY_PHRASES.english.high) {
      if (lowerText.includes(phrase)) {
        detectedPhrases.push(phrase);
        if (language === 'unknown') language = 'english';
        severity = 'high';
      }
    }
  }

  // Check medium only if still none
  if (severity === 'none') {
    for (const phrase of EMERGENCY_PHRASES.romanian.medium) {
      if (lowerText.includes(phrase)) {
        detectedPhrases.push(phrase);
        language = 'romanian';
        severity = 'medium';
      }
    }
    for (const phrase of EMERGENCY_PHRASES.english.medium) {
      if (lowerText.includes(phrase)) {
        detectedPhrases.push(phrase);
        if (language === 'unknown') language = 'english';
        severity = 'medium';
      }
    }
  }

  return {
    isEmergency: severity !== 'none',
    severity,
    detectedPhrases,
    language,
    requiresConfirmation: severity === 'medium',
  };
}

/**
 * Get emergency response in appropriate language
 */
export function getEmergencyResponse(language: 'romanian' | 'english' | 'unknown', requiresConfirmation: boolean): string {
  if (requiresConfirmation) {
    return language === 'english' ? EMERGENCY_RESPONSES.englishConfirmation : EMERGENCY_RESPONSES.romanianConfirmation;
  }
  if (language === 'english') {
    return EMERGENCY_RESPONSES.english;
  }
  return EMERGENCY_RESPONSES.romanian; // Default to Romanian
}

/**
 * Send Telegram alert to Pafi with retry
 * FIX #10: Retry with exponential backoff
 */
export async function sendEmergencyAlert(
  botToken: string,
  chatId: number,
  phoneNumber: string,
  transcribedText: string,
  detectedPhrases: string[],
  severity: 'critical' | 'high' | 'medium',
): Promise<void> {
  // Severity emojis
  const severityEmoji = severity === 'critical' ? '🚨🚨🚨' : severity === 'high' ? '🚨' : '⚠️';

  const message = `${severityEmoji} EMERGENCY ALERT (${severity.toUpperCase()}) ${severityEmoji}

Phone: ${escapeHtml(phoneNumber)}
Time: ${new Date().toISOString()}

Detected phrases: ${escapeHtml(detectedPhrases.join(', '))}

Full message:
"${escapeHtml(transcribedText)}"

This is an automated alert from the Voice Agent.`;

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (response.ok) {
        console.log(`[EMERGENCY ALERT] Sent on attempt ${attempt}`);
        return;
      }
      console.error(`[EMERGENCY ALERT] Attempt ${attempt} failed: ${response.status}`);
    } catch (error) {
      console.error(`[EMERGENCY ALERT] Attempt ${attempt} error:`, error);
    }

    if (attempt < maxRetries) {
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  console.error(`[EMERGENCY ALERT] All ${maxRetries} attempts failed`);
}

/**
 * Log emergency to Cortex
 */
export async function logEmergencyToCortex(
  cortexUrl: string,
  phoneNumber: string,
  transcribedText: string,
  detectedPhrases: string[],
): Promise<void> {
  const logEntry = {
    type: 'emergency',
    timestamp: new Date().toISOString(),
    phoneNumber,
    transcribedText,
    detectedPhrases,
    source: 'genie-voice-agent',
  };

  try {
    // Store in Cortex procedures collection
    const response = await fetch(`${cortexUrl}/api/procedures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Emergency call from ${phoneNumber}`,
        problem: transcribedText,
        solution: `Emergency detected with phrases: ${detectedPhrases.join(', ')}`,
        context: JSON.stringify(logEntry),
        category: 'emergency',
        tags: ['emergency', 'voice-call', 'alert'],
      }),
    });

    if (!response.ok) {
      console.error('Failed to log emergency to Cortex:', await response.text());
    }
  } catch (error) {
    console.error('Error logging emergency to Cortex:', error);
  }
}

/**
 * Handle emergency detection
 * Returns emergency response text if emergency detected, null otherwise
 */
export async function handleEmergency(
  text: string,
  config: {
    telegramBotToken: string;
    telegramChatId: number;
    cortexUrl: string;
    phoneNumber: string;
    agentName?: string;
    ownerName?: string;
  },
): Promise<string | null> {
  const detection = detectEmergency(text);

  if (!detection.isEmergency) {
    return null;
  }

  // Log emergency
  console.log(`[EMERGENCY] Detected in call from ${config.phoneNumber}:`, detection.detectedPhrases, `severity: ${detection.severity}`);

  // For medium severity, return confirmation prompt (don't send alert yet)
  if (detection.requiresConfirmation) {
    return getEmergencyResponse(detection.language, true);
  }

  // For critical/high: send alert immediately
  sendEmergencyAlert(
    config.telegramBotToken,
    config.telegramChatId,
    config.phoneNumber,
    text,
    detection.detectedPhrases,
    detection.severity,
  ).catch(err => console.error('Emergency alert failed:', err));

  // Log to Cortex (async, don't wait)
  logEmergencyToCortex(
    config.cortexUrl,
    config.phoneNumber,
    text,
    detection.detectedPhrases,
  ).catch(err => console.error('Cortex logging failed:', err));

  // Return emergency response
  return getEmergencyResponse(detection.language, false);
}
