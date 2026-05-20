require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');

const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    SlashCommandBuilder,
    PermissionFlagsBits,
    Events,
    ChannelType
} = require('discord.js');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const ESCROW_CONFIG_FILE = path.join(__dirname, 'escrow-config.json');
const escrowConfigMap = new Map();
const escrowCodeMap = new Map(); // userId -> { code, expiresAt, guildId }
const escrowPendingMessageMap = new Map(); // userId -> { code, expiresAt, guildId, channelId }
const escrowSmsNoticeStateMap = new Map(); // userId -> { code, notifiedAt }
const DEFAULT_ESCROW_EMAIL = 'hwanzixwan@gmail.com';
const DEFAULT_ESCROW_PANEL_IMAGE_1 = path.join(__dirname, 'assets', 'escrow-panel-1.svg');
const DEFAULT_ESCROW_PANEL_IMAGE_2 = path.join(__dirname, 'assets', 'escrow-panel-2.svg');
const ESCROW_PANEL_IMAGE_SOURCES = [
    process.env.ESCROW_PANEL_IMAGE_URL_1 ?? DEFAULT_ESCROW_PANEL_IMAGE_1,
    process.env.ESCROW_PANEL_IMAGE_URL_2 ?? DEFAULT_ESCROW_PANEL_IMAGE_2
].filter(Boolean);
const ESCROW_IMAP_HOST = 'imap.gmail.com';
const ESCROW_IMAP_PORT = 993;
const ESCROW_POLL_INTERVAL_MS = 5000;
const ESCROW_MAILBOX_CANDIDATES = [
    'INBOX',
    '[Gmail]/Spam',
    '[Google Mail]/Spam',
    'Spam'
];
const ESCROW_DEFAULT_SUCCESS_CHANNEL_ID = '1502713125827510445';
const ESCROW_PANEL_CHANNEL_NAME = '인증';
const ESCROW_LOG_CHANNEL_NAME = '인증로그';
const ESCROW_BUTTON_COOLDOWN_MS = 5 * 60 * 1000;
const ESCROW_TEMP_MESSAGE_TTL_MS = 30 * 1000;
const ESCROW_NOTICE_SWEEP_INTERVAL_MS = 60 * 1000;
const ESCROW_SMS_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const ESCROW_PROCESSED_MAIL_TTL_MS = 30 * 60 * 1000;
const ESCROW_CODES_FILE = path.join(__dirname, 'escrow-codes.json');

let escrowImapClient = null;
let escrowImapPolling = false;
let escrowImapPollingTimer = null;
let escrowNoticeSweeperTimer = null;
const escrowMailboxStateMap = new Map();
const escrowButtonCooldownMap = new Map(); // userId -> lastPressedAt
const escrowProcessedMailMap = new Map(); // messageKey -> processedAt
let escrowImapConsecutiveErrorCount = 0; // 연속 에러 카운트
let escrowImapLastErrorTime = 0; // 마지막 에러 시각
let escrowImapBackoffMultiplier = 1; // 백오프 승수
const escrowFailedMailboxesMap = new Map(); // mailboxName -> lastFailedTime (존재하지 않는 메일함 캐시)
const ESCROW_IMAP_MAX_CONSECUTIVE_ERRORS = 10; // 최대 연속 에러 횟수
const ESCROW_IMAP_BASE_BACKOFF_MS = 30000; // 기본 백오프 30초
const ESCROW_IMAP_MAX_BACKOFF_MS = 600000; // 최대 백오프 10분
const ESCROW_FAILED_MAILBOX_TTL_MS = 3600000; // 실패한 메일함 캐시 1시간

let redisClient = null;

if (process.env.REDIS_URL) {
    try {
        const IORedis = require('ioredis');
        redisClient = new IORedis(process.env.REDIS_URL);

        redisClient.on('error', err => {
            console.error('Redis error:', err);
        });
    } catch (e) {
        console.warn('ioredis 패키지 로드 실패, Redis 미사용:', e && e.message);
        redisClient = null;
    }
}

async function loadEscrowConfig() {
    try {
        const raw = await fs.readFile(ESCROW_CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        for (const [guildId, config] of Object.entries(parsed)) {
            escrowConfigMap.set(guildId, config);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('에스크로 설정 로드 실패:', error);
    }
}

async function loadEscrowCodes() {
    try {
        if (redisClient) {
            const raw = await redisClient.get('escrow:codes');

            if (!raw) return;

            const parsed = JSON.parse(raw);

            escrowCodeMap.clear();

            for (const [userId, entry] of Object.entries(parsed)) {
                escrowCodeMap.set(userId, entry);
            }

            return;
        }

        const raw = await fs.readFile(ESCROW_CODES_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        escrowCodeMap.clear();

        for (const [userId, entry] of Object.entries(parsed)) {
            escrowCodeMap.set(userId, entry);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('escrow codes load 실패:', error);
    }
}

async function saveEscrowCodes() {
    try {
        const serialized = JSON.stringify(Object.fromEntries(escrowCodeMap.entries()), null, 2);

        if (redisClient) {
            await redisClient.set('escrow:codes', serialized);
            return;
        }

        await fs.writeFile(ESCROW_CODES_FILE, serialized, 'utf8');
    } catch (error) {
        console.error('escrow codes save 실패:', error);
    }
}

async function saveEscrowConfig() {
    const serialized = JSON.stringify(Object.fromEntries(escrowConfigMap.entries()), null, 2);
    await fs.writeFile(ESCROW_CONFIG_FILE, serialized, 'utf8');
}

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function ensureEscrowVerifiedRole(guild) {

    let guildConfig = getGuildConfig(guild.id);
    let roleId = guildConfig?.escrowVerifiedRoleId ?? null;

    let roleObj = roleId ? guild.roles.cache.get(roleId) : null;

    if (!roleObj) {
        roleObj = await guild.roles.create({ name: '거래인증', reason: '에스크로 인증 역할 생성' });
        guildConfig = Object.assign({}, guildConfig, { escrowVerifiedRoleId: roleObj.id });
        guildSettingsMap.set(guild.id, guildConfig);
        await saveGuildSettings();
    }

    return roleObj;
}

async function ensureEscrowChannel(guild, channelName, reason, overwrites = []) {

    let channel = guild.channels.cache.find(existingChannel =>
        existingChannel.type === ChannelType.GuildText &&
        existingChannel.name === channelName
    ) ?? null;

    if (!channel) {
        channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            reason,
            permissionOverwrites: overwrites
        });
    }

    return channel;
}

async function resolveEscrowLogChannel(guild) {

    const guildConfig = getGuildConfig(guild.id);
    const configuredChannelId = guildConfig?.escrowLogChannelId ?? null;
    const configuredChannel = configuredChannelId
        ? await client.channels.fetch(configuredChannelId).catch(() => null)
        : null;

    if (configuredChannel?.isTextBased?.() && configuredChannel.guild?.id === guild.id) {
        return configuredChannel;
    }

    const createdChannel = await ensureEscrowChannel(
        guild,
        ESCROW_LOG_CHANNEL_NAME,
        '인증로그 자동 세팅 채널 생성',
        [
            {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
            }
        ]
    );

    guildSettingsMap.set(guild.id, {
        ...guildConfig,
        escrowLogChannelId: createdChannel.id
    });
    await saveGuildSettings();

    return createdChannel;
}

async function resolveEscrowPanelChannel(guild) {

    const guildConfig = getGuildConfig(guild.id);
    const configuredChannelId = guildConfig?.escrowPanelChannelId ?? null;
    const configuredChannel = configuredChannelId
        ? await client.channels.fetch(configuredChannelId).catch(() => null)
        : null;

    if (configuredChannel?.isTextBased?.() && configuredChannel.guild?.id === guild.id) {
        return configuredChannel;
    }

    const createdChannel = await ensureEscrowChannel(
        guild,
        ESCROW_PANEL_CHANNEL_NAME,
        '인증 패널 자동 세팅 채널 생성'
    );

    guildSettingsMap.set(guild.id, {
        ...guildConfig,
        escrowPanelChannelId: createdChannel.id
    });
    await saveGuildSettings();

    return createdChannel;
}

function buildEscrowLogContent(senderLabel, code, hasInputPhrase, member) {

    const lines = [
        '## 신용인 인증 완료',
        `- 발신자: ${senderLabel}`,
        `- 인증코드: ${code}`,
        `- 입력문구 포함: ${hasInputPhrase ? '예' : '아니오'}`
    ];

    if (member) {
        try {
            const userTag = member.user?.tag ?? `${member.user?.username ?? 'Unknown'}#?`;
            const userId = member.id ?? (member.user?.id ?? '알 수 없음');
            lines.push(`- 디스코드: <@${userId}> (${userTag}, ${userId})`);
        } catch {
            // ignore member formatting errors
        }
    }

    lines.push(`- 처리 시각: <t:${Math.floor(Date.now() / 1000)}:F>`);

    return lines.join('\n');
}

function getEscrowRecipientEmail(guildId) {

    return escrowConfigMap.get(guildId)?.email ?? DEFAULT_ESCROW_EMAIL;
}

function extractSixDigitCode(text) {

    const match = String(text ?? '').match(/\b(\d{6})\b/);
    return match ? match[1] : null;
}

function collectMailSearchText(parsed) {

    const parts = [parsed.subject, parsed.text, parsed.html].filter(Boolean).map(value => String(value));

    for (const attachment of parsed.attachments ?? []) {
        const filename = attachment.filename ?? '';
        const contentType = attachment.contentType ?? '';
        const isTextAttachment = contentType.startsWith('text/') || /\.txt$/i.test(filename);

        if (!isTextAttachment) continue;

        const attachmentText = Buffer.isBuffer(attachment.content)
            ? attachment.content.toString('utf8')
            : String(attachment.content ?? '');

        if (attachmentText.trim().length > 0) {
            parts.push(attachmentText);
        }
    }

    return parts.join('\n');
}

function getMailSenderLabel(parsed) {

    const senderAddress = parsed.from?.value?.[0]?.address ?? null;
    const senderName = parsed.from?.value?.[0]?.name ?? null;

    if (senderName && senderAddress) return `${senderName} <${senderAddress}>`;
    if (senderAddress) return senderAddress;
    if (parsed.from?.text) return parsed.from.text;

    return '알 수 없음';
}

function isPhoneNumberSender(senderAddress) {
    // 전화번호 형식 발신자 확인: 010으로 시작하는 번호만 허락 (01023181764@mms.kt.co.kr 형태)
    // 패턴: 010 + 7~8자리 숫자 @ 도메인
    return /^010\d{7,8}@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(senderAddress);
}

function cleanupProcessedMailMap(now = Date.now()) {

    for (const [messageKey, processedAt] of escrowProcessedMailMap.entries()) {
        if (now - processedAt > ESCROW_PROCESSED_MAIL_TTL_MS) {
            escrowProcessedMailMap.delete(messageKey);
        }
    }
}

function markMailAsProcessed(messageKey, now = Date.now()) {

    cleanupProcessedMailMap(now);

    if (escrowProcessedMailMap.has(messageKey)) {
        return false;
    }

    escrowProcessedMailMap.set(messageKey, now);
    return true;
}

function shouldSendEscrowSmsNotice(userId, code, now = Date.now()) {

    const state = escrowSmsNoticeStateMap.get(userId);

    if (state && state.code === code && (now - state.notifiedAt) < ESCROW_SMS_NOTICE_COOLDOWN_MS) {
        return false;
    }

    escrowSmsNoticeStateMap.set(userId, { code, notifiedAt: now });
    return true;
}

function isEscrowTemporaryNoticeContent(content) {

    const text = String(content ?? '');
    return text.includes('인증이 완료되었습니다.') ||
    text.includes('인증 되었습니다.') ||
    text.includes('인증되었습니다.') ||
        text.includes('SMS 문자로 보내주세요.') ||
        text.includes('인증코드가 일치하지 않습니다.');
}

function isEscrowTemporaryNoticeMessage(message) {

    if (!message) return false;
    if (!client.user || message.author?.id !== client.user.id) return false;

    return isEscrowTemporaryNoticeContent(message.content);
}

async function cleanupEscrowTemporaryNoticesInChannel(channel, olderThanMs = ESCROW_TEMP_MESSAGE_TTL_MS) {

    if (!channel?.isTextBased?.() || !channel.messages?.fetch) return;

    const now = Date.now();
    const recentMessages = await channel.messages.fetch({ limit: 50 }).catch(() => null);

    if (!recentMessages) return;

    for (const message of recentMessages.values()) {
        if (!isEscrowTemporaryNoticeMessage(message)) continue;
        if ((now - message.createdTimestamp) < olderThanMs) continue;

        await message.delete().catch(() => null);
    }
}

async function sendEscrowTemporaryNotice(channel, content, ttlMs = ESCROW_TEMP_MESSAGE_TTL_MS) {

    if (!channel?.isTextBased?.()) return null;

    await cleanupEscrowTemporaryNoticesInChannel(channel, ttlMs);

    const sentMessage = await channel.send({ content }).catch(() => null);

    if (!sentMessage) return null;

    setTimeout(async () => {
        try {
            await sentMessage.delete().catch(() => null);
        } catch {
            // ignore temporary message delete failures
        }
    }, ttlMs);

    return sentMessage;
}

async function cleanupEscrowTemporaryNoticesAtStartup() {

    // 이전에는 일부 설정 채널들만 검사했으나, 봇이 메시지를 보낼 수 있는 모든 길드의
    // 텍스트 채널을 순회하여 남아있는 임시 인증 메시지를 정리하도록 변경합니다.

    // 먼저 기존에 명시된 채널들도 함께 처리 (안전망)
    const targetChannelIds = new Set([TARGET_ESCROW_CHANNEL_ID, ESCROW_DEFAULT_SUCCESS_CHANNEL_ID]);

    for (const [, guildConfig] of guildSettingsMap.entries()) {
        if (guildConfig?.escrowPanelChannelId) targetChannelIds.add(guildConfig.escrowPanelChannelId);
        if (guildConfig?.escrowLogChannelId) targetChannelIds.add(guildConfig.escrowLogChannelId);
    }

    // 정적으로 지정된 채널들 먼저 정리
    for (const channelId of targetChannelIds) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) continue;
        await cleanupEscrowTemporaryNoticesInChannel(channel, ESCROW_TEMP_MESSAGE_TTL_MS);
    }

    // 이제 봇이 속한 모든 길드의 텍스트 채널을 순회하여 임시 메시지를 정리
    for (const guild of client.guilds.cache.values()) {
        // 채널 정보를 최신으로 가져오려 시도
        try {
            await guild.channels.fetch();
        } catch (e) {
            // 채널 목록을 가져오지 못하면 그 길드는 건너뜁니다
            continue;
        }

        for (const channel of guild.channels.cache.values()) {
            if (!channel?.isTextBased?.() || typeof channel.messages?.fetch !== 'function') continue;

            await cleanupEscrowTemporaryNoticesInChannel(channel, ESCROW_TEMP_MESSAGE_TTL_MS).catch(() => null);
        }
    }
}

function startEscrowTemporaryNoticeSweeper() {

    if (escrowNoticeSweeperTimer) return;

    escrowNoticeSweeperTimer = setInterval(() => {
        cleanupEscrowTemporaryNoticesAtStartup().catch(error => {
            console.error('임시 인증 알림 정리 실패:', error);
        });
    }, ESCROW_NOTICE_SWEEP_INTERVAL_MS);
}

function findEscrowEntryByCode(code) {

    for (const [userId, entry] of escrowCodeMap.entries()) {
        if (entry.code !== code) continue;
        if (Date.now() > entry.expiresAt) continue;

        return { userId, ...entry };
    }

    return null;
}

async function connectEscrowMailbox() {

    // Support multiple common env names for IMAP credentials
    const user = process.env.SMTP_USER ?? process.env.IMAP_USER ?? process.env.ESCROW_IMAP_USER;
    const pass = process.env.SMTP_PASS ?? process.env.IMAP_PASS ?? process.env.ESCROW_IMAP_PASS;

    if (!user || !pass) {
        console.warn('메일 수신용 SMTP 사용자/비밀번호가 설정되어 있지 않습니다.');
        return null;
    }

    if (escrowImapClient) return escrowImapClient;

    escrowImapClient = new ImapFlow({
        host: ESCROW_IMAP_HOST,
        port: ESCROW_IMAP_PORT,
        secure: true,
        auth: { user, pass }
    });

    try {
        await escrowImapClient.connect();
        console.log('[인증] IMAP 연결 성공');
        return escrowImapClient;
    } catch (error) {
        const errorMsg = String(error?.message ?? error);
        const isAuthError = errorMsg.includes('EAUTH') || errorMsg.includes('invalid') || errorMsg.includes('rejected');

        if (isAuthError) {
            console.error('❌ IMAP 인증 실패 - 자격증명 확인 필요:', errorMsg.split('\n')[0]);
        } else {
            console.warn('⚠️ IMAP 연결 임시 실패:', errorMsg.split('\n')[0]);
        }

        try {
            await escrowImapClient.logout();
        } catch {
            // ignore logout failures during reconnect
        }

        escrowImapClient = null;
        return null;
    }
}

async function processEscrowMailMessage(rawMessage) {

    const messageKey = `${rawMessage.mailboxName ?? 'unknown'}:${rawMessage.uid ?? 'no-uid'}`;

    if (!markMailAsProcessed(messageKey)) {
        return;
    }

    const parsed = await simpleParser(rawMessage.source);
    const searchableText = collectMailSearchText(parsed);
    const code = extractSixDigitCode(searchableText);
    const hasInputPhrase = searchableText.includes('입력되었습니다');
    const senderLabel = getMailSenderLabel(parsed);
    const senderAddress = (parsed.from?.value?.[0]?.address ?? '').toLowerCase();

    console.log('인증 메일 확인:', { senderLabel, hasInputPhrase, hasCode: Boolean(code), senderAddress });

    if (!code) return;

    const pending = findEscrowEntryByCode(code);

    if (!pending) return;

    const guild = await client.guilds.fetch(pending.guildId).catch(() => null);

    if (!guild) return;

    const member = await guild.members.fetch(pending.userId).catch(() => null);

    if (!member) return;

    const guildConfig = getGuildConfig(guild.id);
    const notificationChannel = await resolveEscrowLogChannel(guild).catch(() => null);

    // 전화번호 형식 발신자만 인증 처리
    if (!isPhoneNumberSender(senderAddress)) {
        console.log('아이디 형식 발신자, 거절:', senderAddress);

        // 같은 사용자/인증코드에 대해 일정 시간 동안 SMS 안내 멘션을 1회만 전송
        if (!shouldSendEscrowSmsNotice(pending.userId, code)) {
            return;
        }

        // 사용자에게 SMS로 보내달라고 알림 (30초 후 삭제)
        try {
            let notifyChannel = pending?.channelId
                ? await client.channels.fetch(pending.channelId).catch(() => null)
                : null;

            if (!notifyChannel) {
                const panelChannel = await resolveEscrowPanelChannel(guild).catch(() => null);
                notifyChannel = panelChannel;
            }

            if (notifyChannel?.isTextBased?.()) {
                await sendEscrowTemporaryNotice(notifyChannel, `<@${member.id}>님 SMS 문자로 보내주세요.`);
            }
        } catch (e) {
            console.error('거절 알림 전송 실패:', e);
        }

        return;
    }

    const roleObj = await ensureEscrowVerifiedRole(guild);

    // Debug logging: show which pending entry we're processing
    try {
        console.log('인증 처리중:', { code, userId: pending.userId, guildId: pending.guildId, channelId: pending.channelId });
    } catch {}

    // Check bot role position vs target role to avoid silent failures
    try {
        const botMember = await guild.members.fetch(client.user.id).catch(() => null);

        if (botMember && roleObj && botMember.roles.highest && typeof botMember.roles.highest.position === 'number') {
            if (botMember.roles.highest.position <= roleObj.position) {
                console.error('봇의 역할이 거래인증 역할보다 낮아 역할 부여 불가');

                try {
                    const adminNotice = notificationChannel?.isTextBased?.() ? notificationChannel : (pending.channelId ? await client.channels.fetch(pending.channelId).catch(() => null) : null);

                    if (adminNotice?.isTextBased?.()) {
                        await adminNotice.send({ content: `⚠️ 인증 처리 실패: 봇 권한 문제로 <@${member.id}> 님에게 거래인증 역할을 부여할 수 없습니다. 봇의 역할을 '거래인증' 역할 위로 올려주세요.` }).catch(() => null);
                    }
                } catch (e) {
                    console.error('권한 경고 전송 실패:', e);
                }

                return;
            }
        }
    } catch (e) {
        console.error('봇 역할 포지션 체크 실패:', e);
    }

    try {
        await member.roles.add(roleObj.id);
        console.log(`거래인증 역할 부여 성공: ${member.id} -> ${roleObj.id}`);
    } catch (error) {
        console.error('거래인증 역할 부여 실패:', error);

        try {
            const errChannel = pending.channelId ? await client.channels.fetch(pending.channelId).catch(() => null) : null;

            if (errChannel?.isTextBased?.()) {
                await errChannel.send({ content: `<@${member.id}> 인증 처리 중 오류가 발생했습니다. 관리자에게 문의해주세요.` }).catch(() => null);
            }
        } catch (e) {
            console.error('오류 알림 전송 실패:', e);
        }
    }

    escrowPendingMessageMap.delete(pending.userId);
    escrowCodeMap.delete(pending.userId);
    await saveEscrowCodes();

    const completionMessage = `<@${member.id}> 인증되었습니다.`;

    const notificationMessage = buildEscrowLogContent(senderLabel, code, hasInputPhrase, member);

    if (notificationChannel?.isTextBased?.()) {
        await notificationChannel.send({ content: notificationMessage }).catch(error => {
            console.error('인증로그 채널 전송 실패:', error);
        });
    } else {
        console.warn(`인증로그 채널을 찾지 못했거나 전송할 수 없습니다: ${guild.id}`);
    }

    // escrowPanelChannelId가 설정되지 않았으면 자동으로 생성
    const panelChannel = await resolveEscrowPanelChannel(guild).catch(() => null);
    
    const tempNoticeChannelIds = new Set(
        [pending.channelId, panelChannel?.id].filter(Boolean)
    );

    for (const channelId of tempNoticeChannelIds) {
        const tempChannel = await client.channels.fetch(channelId).catch(() => null);

        if (!tempChannel?.isTextBased?.()) continue;

        try {
            await sendEscrowTemporaryNotice(tempChannel, completionMessage);
        } catch (error) {
            console.error('임시 완료 알림 전송 실패:', error);
        }
    }
}

async function pollEscrowMailbox() {

    const now = Date.now();

    // 백오프 중인지 확인 (지수 백오프)
    if (escrowImapConsecutiveErrorCount >= ESCROW_IMAP_MAX_CONSECUTIVE_ERRORS) {
        const backoffTime = Math.min(
            ESCROW_IMAP_BASE_BACKOFF_MS * escrowImapBackoffMultiplier,
            ESCROW_IMAP_MAX_BACKOFF_MS
        );
        const timeSinceLastError = now - escrowImapLastErrorTime;

        if (timeSinceLastError < backoffTime) {
            console.warn(
                `[인증] IMAP 폴링 백오프 중... (에러 ${escrowImapConsecutiveErrorCount}회, ` +
                `${Math.ceil((backoffTime - timeSinceLastError) / 1000)}초 후 재시도)`
            );
            return;
        }

        // 백오프 완료 후 초기화
        console.log('[인증] IMAP 백오프 완료, 폴링 재개');
        escrowImapConsecutiveErrorCount = 0;
        escrowImapBackoffMultiplier = 1;
    }

    const imapClient = await connectEscrowMailbox();

    if (!imapClient) {
        escrowImapConsecutiveErrorCount++;
        escrowImapLastErrorTime = now;
        if (escrowImapConsecutiveErrorCount < 5) escrowImapBackoffMultiplier = 1;
        else if (escrowImapConsecutiveErrorCount < 8) escrowImapBackoffMultiplier = 2;
        else escrowImapBackoffMultiplier = 4;
        return;
    }

    if (escrowImapPolling) return;

    escrowImapPolling = true;

    try {
        let hasErrors = false;

        for (const mailboxName of ESCROW_MAILBOX_CANDIDATES) {
            // 최근에 실패한 메일함이면 건너뛰기
            const failedAt = escrowFailedMailboxesMap.get(mailboxName);
            if (failedAt && (now - failedAt) < ESCROW_FAILED_MAILBOX_TTL_MS) {
                continue;
            }

            const mailbox = await imapClient.mailboxOpen(mailboxName).catch((err) => {
                console.warn(`메일함 접근 실패 (캐시 처리): ${mailboxName} - ${err?.message?.split('\n')[0]}`);
                escrowFailedMailboxesMap.set(mailboxName, now);
                hasErrors = true;
                return null;
            });

            if (!mailbox) continue;

            const mailboxState = escrowMailboxStateMap.get(mailboxName) ?? {
                lastUid: Math.max(0, (mailbox.uidNext ?? 1) - 1)
            };

            const startUid = mailboxState.lastUid + 1;

            try {
                for await (const message of imapClient.fetch(`${startUid}:*`, { uid: true, source: true })) {
                    mailboxState.lastUid = Math.max(mailboxState.lastUid, message.uid ?? mailboxState.lastUid);
                    escrowMailboxStateMap.set(mailboxName, mailboxState);

                    try {
                        await processEscrowMailMessage({ ...message, mailboxName });
                    } catch (error) {
                        console.error('인증 메일 처리 실패:', error);
                    }
                }
            } catch (fetchError) {
                console.error(`메일함 FETCH 실패: ${mailboxName}`, fetchError?.message?.split('\n')[0]);
                hasErrors = true;
            }
        }

        // 에러가 없었으면 에러 카운트 리셋
        if (!hasErrors && escrowImapConsecutiveErrorCount > 0) {
            console.log('[인증] IMAP 폴링 정상 완료, 에러 카운트 초기화');
            escrowImapConsecutiveErrorCount = 0;
            escrowImapBackoffMultiplier = 1;
        }
    } catch (error) {
        console.error('인증 메일함 조회 실패:', error?.message?.split('\n')[0]);
        escrowImapConsecutiveErrorCount++;
        escrowImapLastErrorTime = now;

        if (escrowImapConsecutiveErrorCount < 5) escrowImapBackoffMultiplier = 1;
        else if (escrowImapConsecutiveErrorCount < 8) escrowImapBackoffMultiplier = 2;
        else escrowImapBackoffMultiplier = 4;

        try {
            await imapClient.logout();
        } catch {
            // ignore logout failures
        }

        escrowImapClient = null;
    } finally {
        escrowImapPolling = false;
    }
}

async function startEscrowMailboxWatcher() {

    if (escrowImapPollingTimer) return;

    await pollEscrowMailbox();

    escrowImapPollingTimer = setInterval(() => {
        pollEscrowMailbox().catch(error => {
            console.error('인증 메일 폴러 오류:', error);
        });
    }, ESCROW_POLL_INTERVAL_MS);
}

async function registerGuildCommands(guild) {

    await guild.commands.set([
        BROKER_COMMAND.toJSON(),
        OYE_COMMAND.toJSON(),
        HIGH_VALUE_COMMAND.toJSON(),
        WISHLIST_PANEL_COMMAND.toJSON(),
        SETTING_COMMAND.toJSON(),
        ESCROW_SET_COMMAND.toJSON(),
        ESCROW_SEND_COMMAND.toJSON(),
        ESCROW_VERIFY_COMMAND.toJSON()
    ]);
}

const EPHEMERAL_FLAGS = 64;
const GUILD_SETTINGS_FILE = path.join(__dirname, 'guild-settings.json');
const guildSettingsMap = new Map();

async function loadGuildSettings() {

    try {
        const raw = await fs.readFile(GUILD_SETTINGS_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        for (const [guildId, config] of Object.entries(parsed)) {
            guildSettingsMap.set(guildId, config);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('길드 설정 로드 실패:', error);
        }
    }
}

async function saveGuildSettings() {

    const serialized = JSON.stringify(Object.fromEntries(guildSettingsMap.entries()), null, 2);
    await fs.writeFile(GUILD_SETTINGS_FILE, serialized, 'utf8');
}

async function replyEphemeral(interaction, payload) {

    return interaction.reply({
        ...payload,
        flags: EPHEMERAL_FLAGS
    });
}

async function deferEphemeralReply(interaction) {

    return interaction.deferReply({
        flags: EPHEMERAL_FLAGS
    });
}


// ===== 역할 정보 =====
const ROLES = {

    keeper: {
        id: '1502716547893035200',
        label: '키퍼',
        emoji: {
            id: '1502726480722137098',
            name: 'keyper'
        }
    },

    gospec: {
        id: '1502729557071888595',
        label: '고스팩',
        emoji: {
            id: '1503252997264900166',
            name: 'Handgun_28Gamemode29'
        }
    },

    valorant: {
        id: '1502716542192980029',
        label: '발로란트',
        emoji: {
            id: '1502726722569895997',
            name: 'valorant'
        }
    },

    keyskin: {
        id: '1502716546181496992',
        label: '키 스킨',
        emoji: {
            id: '1502726555032617129',
            name: 'akey'
        }
    },

    archnem: {
        id: '1502716544323555348',
        label: '아크 크로스보우',
        emoji: {
            id: '1502726527429644388',
            name: 'arch'
        }
    },

    archkatana: {
        id: '1503251234751119430',
        label: '아크 카타나',
        emoji: {
            id: '1503252895481462956',
            name: 'ArchKatana_Icon'
        }
    },

    archmolotov: {
        id: '1503251243655495801',
        label: '아크 화염병',
        emoji: {
            id: '1503252938489860106',
            name: 'ArchMolotov_Icon'
        }
    },

    crystal: {
        id: '1502716530943852695',
        label: '크리스탈',
        emoji: {
            id: '1502726456286122176',
            name: 'Crystal'
        }
    },

    keythe: {
        id: '1502716549364977836',
        label: '키낫',
        emoji: {
            id: '1502726429974986752',
            name: 'keythe'
        }
    },

    total: {
        id: '1502729662089003140',
        label: '종합계',
        emoji: {
            id: '1503259150237565020',
            name: 'Roblox_Logo_2025'
        }
    },

    sub: {
        id: '1502729710960906351',
        label: '부계용',
        emoji: {
            id: '1503258840081367060',
            name: 'Pumpkin_Claws_dsdsd'
        }
    },

    brawlstars: {
        id: '1503258866962399303',
        label: '브롤스타즈',
        emoji: {
            id: '1503258788818587832',
            name: 'BrawlStarsStar'
        }
    }
};


// ===== 위시리스트 카테고리 =====
const WISHLIST_CATEGORIES = {

    roblox_rivals: {
        label: '로블록스 라이벌',
        description: '로블록스 라이벌 관련 위시리스트',
        items: ['total', 'keyskin', 'keeper', 'keythe', 'crystal', 'archnem', 'archkatana', 'archmolotov', 'gospec', 'sub']
    },

    other_games: {
        label: '타 게임',
        description: '타 게임 관련 위시리스트',
        items: ['valorant', 'brawlstars']
    }
};


const WISHLIST_CATEGORY_SELECT_ID = 'wishlist_category_select';

const WISHLIST_ITEM_SELECT_PREFIX = 'wishlist_items:';

const WISHLIST_SEARCH_BUTTON_ID = 'wishlist_search';

const WISHLIST_SEARCH_MODAL_ID = 'wishlist_search_modal';

const WISHLIST_SEARCH_RESULT_PREFIX = 'wishlist_search_results:';


function normalizeRoleName(name) {

    return name?.trim().toLowerCase();
}

function normalizeSearchText(text) {

    return text?.trim().toLowerCase().replace(/\s+/g, '');
}

function resolveWishlistRole(guild, itemKey) {

    if (!guild) return null;

    const roleInfo = ROLES[itemKey];

    if (!roleInfo) return null;

    if (roleInfo.id) {
        const byId = guild.roles.cache.get(roleInfo.id);

        if (byId) return byId;
    }

    const targetName = normalizeRoleName(roleInfo.label);

    if (!targetName) return null;

    return guild.roles.cache.find(role => normalizeRoleName(role.name) === targetName) ?? null;
}


function buildCategoryMenu() {

    return new StringSelectMenuBuilder()
        .setCustomId(WISHLIST_CATEGORY_SELECT_ID)
        .setPlaceholder('위시리스트 종류 선택')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            Object.entries(WISHLIST_CATEGORIES).map(([key, value]) => ({
                label: value.label,
                description: value.description,
                value: key
            }))
        );
}

function buildWishlistIntroEmbed() {

    const keeperEmoji = `<:${ROLES.keeper.emoji.name}:${ROLES.keeper.emoji.id}>`;

    const categoryFieldMap = {
        roblox_rivals: '로블록스 라이벌',
        other_games: '타 게임'
    };

    const categoryFields = Object.entries(WISHLIST_CATEGORIES).map(([categoryKey, category]) => {
        const itemLabels = category.items
            .map(itemKey => `• ${ROLES[itemKey].label}`)
            .join('\n');

        return {
            name: `🎮 ${categoryFieldMap[categoryKey] ?? category.label}`,
            value: itemLabels,
            inline: true
        };
    });

    return new EmbedBuilder()
        .setColor(0x5B78FF)
        .setTitle(`${keeperEmoji} 위시리스트`)
        .setDescription('아래에서 게임을 선택해 원하는 아이템을 위시리스트에 등록하세요.\n판매자가 아이템을 판매할 때 바로 알림을 받을 수 있습니다.')
        .addFields(categoryFields)
        .setFooter({
            text: '게임을 선택하거나 검색을 눌러 원하는 항목을 찾아 등록하세요.'
        });
}


function buildItemMenu(guild, categoryKey) {

    const category = WISHLIST_CATEGORIES[categoryKey];

    if (!category) return null;

    const availableItemKeys = category.items.filter(itemKey => resolveWishlistRole(guild, itemKey));

    if (!availableItemKeys.length) return null;

    return new StringSelectMenuBuilder()
        .setCustomId(`${WISHLIST_ITEM_SELECT_PREFIX}${categoryKey}`)
        .setPlaceholder(`${category.label} 위시리스트 선택`)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            availableItemKeys.map(itemKey => ({
                label: ROLES[itemKey].label,
                value: itemKey
            }))
        );
}


function getCategoryRoles(guild, categoryKey) {

    const category = WISHLIST_CATEGORIES[categoryKey];

    if (!category || !guild) return [];

    return category.items
        .map(itemKey => resolveWishlistRole(guild, itemKey))
        .filter(Boolean);
}

function buildWishlistPanelMessage() {

    const selectMenu = buildCategoryMenu();

    const selectRow = new ActionRowBuilder()
        .addComponents(selectMenu);

    const searchButton = new ButtonBuilder()
        .setCustomId(WISHLIST_SEARCH_BUTTON_ID)
        .setLabel('검색')
        .setStyle(ButtonStyle.Primary);

    const resetButton = new ButtonBuilder()
        .setCustomId('reset_roles')
        .setLabel('역할 초기화')
        .setStyle(ButtonStyle.Danger);

    const buttonRow = new ActionRowBuilder()
        .addComponents(searchButton, resetButton);

    return {
        embeds: [buildWishlistIntroEmbed()],
        components: [selectRow, buttonRow]
    };
}

function buildEscrowStartButtonRow() {

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(ESCROW_START_BUTTON_ID)
            .setLabel('인증버튼')
            .setStyle(ButtonStyle.Success)
    );
}

async function buildEscrowPanelEmbeds() {

    const description = [
        '안전거래 혜택',

        '- 거래 신뢰도 상승 및 판매 속도 증가 가능',
        '- 신용인 포스트 이용 가능',
        '- @신용인 역할 지급',
        '',
        '수집되는 정보',
        '- 관리자에게 전화번호가 수집 됨',
        '- 디스코드 숫자ID (사용자 이름)',
        '',
        '수집된 정보는 오직 관리자 @최준원 , @파더 만 확인 가능하며, 안전거래 및 사기 방지 목적 외에는 사용되지 않습니다.',
        '정상적인 거래 이용 시 개인정보가 외부로 유출될 일은 없습니다.',
        '',
        '추천 대상',
        '- 신뢰도를 쌓고 싶은 판매자 / 구매자'
    ].join('\n');

    const embeds = [
        new EmbedBuilder()
            .setColor(0x2B2D31)
            .setTitle('안전거래')
            .setDescription(description)
    ];

    const files = [];

    for (const [index, source] of ESCROW_PANEL_IMAGE_SOURCES.entries()) {
        if (/^https?:\/\//i.test(source)) {
            if (index === 0) {
                embeds[0].setImage(source);
            } else {
                embeds.push(
                    new EmbedBuilder()
                        .setColor(0x2B2D31)
                        .setImage(source)
                );
            }

            continue;
        }

        const absolutePath = path.isAbsolute(source) ? source : path.join(__dirname, source);

        try {
            await fs.access(absolutePath);
            const attachmentName = `escrow-panel-${index + 1}${path.extname(absolutePath) || '.png'}`;
            const attachmentBuffer = await fs.readFile(absolutePath);

            files.push({ attachment: attachmentBuffer, name: attachmentName });

            if (index === 0) {
                embeds[0].setImage(`attachment://${attachmentName}`);
            } else {
                embeds.push(
                    new EmbedBuilder()
                        .setColor(0x2B2D31)
                        .setImage(`attachment://${attachmentName}`)
                );
            }
        } catch {
            console.warn(`신용인 인증 이미지 파일을 찾지 못했습니다: ${source}`);
        }
    }

    return { embeds, files };
}

async function buildEscrowPanelMessage() {

    const { embeds, files } = await buildEscrowPanelEmbeds();

    return {
        embeds,
        files,
        components: [buildEscrowStartButtonRow()]
    };
}

function buildWishlistSearchModal() {

    const modal = new ModalBuilder()
        .setCustomId(WISHLIST_SEARCH_MODAL_ID)
        .setTitle('검색');

    const input = new TextInputBuilder()
        .setCustomId('search_query')
        .setLabel('찾고 싶은 상품명을 입력하세요')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('예: 아크, 키 스킨, 발로란트');

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    return modal;
}

function findWishlistMatches(guild, keyword) {

    const normalizedKeyword = normalizeSearchText(keyword);

    if (!guild || !normalizedKeyword) return [];

    const matches = [];

    for (const [categoryKey, category] of Object.entries(WISHLIST_CATEGORIES)) {
        for (const itemKey of category.items) {
            const role = resolveWishlistRole(guild, itemKey);

            if (!role) continue;

            const searchableFields = [
                ROLES[itemKey].label,
                category.label,
                itemKey
            ]
                .map(normalizeSearchText)
                .filter(Boolean);

            if (searchableFields.some(field => field.includes(normalizedKeyword))) {
                matches.push({
                    categoryKey,
                    itemKey,
                    role
                });
            }
        }
    }

    return matches;
}

function buildWishlistSearchResultMenu(matches, query) {

    if (!matches.length) return null;

    return new StringSelectMenuBuilder()
        .setCustomId(`${WISHLIST_SEARCH_RESULT_PREFIX}${encodeURIComponent(query)}`)
        .setPlaceholder('검색된 상품 중 하나를 선택하세요')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            matches.slice(0, 25).map(match => ({
                label: ROLES[match.itemKey].label,
                description: WISHLIST_CATEGORIES[match.categoryKey].label,
                value: `${match.categoryKey}:${match.itemKey}`
            }))
        );
}

function parseWishlistSelectionValue(value) {

    const [categoryKey, itemKey] = value.split(':');

    if (!categoryKey || !itemKey) return null;

    return { categoryKey, itemKey };
}

function findTextChannelByName(guild, channelName) {

    return guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildText &&
        channel.name === channelName
    ) ?? null;
}

function findForumChannelByName(guild, channelName) {

    return guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildForum &&
        channel.name === channelName
    ) ?? null;
}

async function ensureWishlistRoles(guild) {

    const roleMap = {};

    for (const [itemKey, roleInfo] of Object.entries(ROLES)) {
        const existing = resolveWishlistRole(guild, itemKey);

        if (existing) {
            roleMap[itemKey] = existing;
            continue;
        }

        const created = await guild.roles.create({
            name: roleInfo.label,
            reason: '위시리스트 자동 세팅 역할 생성'
        });

        roleMap[itemKey] = created;
    }

    return roleMap;
}

async function ensureForumTags(forumChannel) {

    const baseTagLabelMap = {
        forSale: '팔아요',
        lookingFor: '구해요',
        trade: '교환해요'
    };

    const requiredNames = new Set([
        ...Object.values(baseTagLabelMap),
        ...Object.values(ROLES).map(role => role.label)
    ]);

    const existingTags = [...forumChannel.availableTags];
    const existingNames = new Set(existingTags.map(tag => tag.name));
    const missingNames = [...requiredNames].filter(name => !existingNames.has(name));

    if (missingNames.length > 0) {
        await forumChannel.edit({
            availableTags: [
                ...existingTags.map(tag => ({
                    id: tag.id,
                    name: tag.name,
                    moderated: tag.moderated,
                    emoji: tag.emoji ?? null
                })),
                ...missingNames.map(name => ({
                    name,
                    moderated: false
                }))
            ]
        });
    }

    const refreshedForum = await forumChannel.guild.channels.fetch(forumChannel.id);
    const finalTags = [...(refreshedForum?.availableTags ?? forumChannel.availableTags)];

    const forumTagIds = {
        forSale: finalTags.find(tag => tag.name === baseTagLabelMap.forSale)?.id ?? null,
        lookingFor: finalTags.find(tag => tag.name === baseTagLabelMap.lookingFor)?.id ?? null,
        trade: finalTags.find(tag => tag.name === baseTagLabelMap.trade)?.id ?? null
    };

    const wishlistTagMapByLabel = new Map(
        finalTags
            .filter(tag => Object.values(ROLES).some(role => role.label === tag.name))
            .map(tag => [tag.name, tag.id])
    );

    return {
        forumTagIds,
        wishlistTagMapByLabel
    };
}

async function setupGuild(guild) {

    await guild.roles.fetch();
    await guild.channels.fetch();

    const wishlistRoleMap = await ensureWishlistRoles(guild);

    let wishlistChannel = findTextChannelByName(guild, '위시리스트');

    if (!wishlistChannel) {
        wishlistChannel = await guild.channels.create({
            name: '위시리스트',
            type: ChannelType.GuildText,
            reason: '위시리스트 자동 세팅 채널 생성'
        });
    }

    let promoChannel = findTextChannelByName(guild, '홍보알림');

    if (!promoChannel) {
        promoChannel = await guild.channels.create({
            name: '홍보알림',
            type: ChannelType.GuildText,
            reason: '홍보 자동 세팅 채널 생성'
        });
    }

    let forumChannel = findForumChannelByName(guild, '거래포럼');

    if (!forumChannel) {
        forumChannel = await guild.channels.create({
            name: '거래포럼',
            type: ChannelType.GuildForum,
            reason: '포럼 자동 세팅 채널 생성'
        });
    }

    const { forumTagIds, wishlistTagMapByLabel } = await ensureForumTags(forumChannel);

    const escrowVerifiedRole = await ensureEscrowVerifiedRole(guild);

    const panelChannel = await ensureEscrowChannel(
        guild,
        ESCROW_PANEL_CHANNEL_NAME,
        '인증 패널 자동 세팅 채널 생성'
    );

    const logChannel = await ensureEscrowChannel(
        guild,
        ESCROW_LOG_CHANNEL_NAME,
        '인증로그 자동 세팅 채널 생성',
        [
            {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
            }
        ]
    );

    const tagRoleMap = {};

    for (const [itemKey, role] of Object.entries(wishlistRoleMap)) {
        const roleLabel = ROLES[itemKey].label;
        const tagId = wishlistTagMapByLabel.get(roleLabel);

        if (!tagId) continue;

        tagRoleMap[tagId] = role.id;
    }

    const guildConfig = {
        wishlistChannelId: wishlistChannel.id,
        forumChannelId: forumChannel.id,
        promoChannelId: promoChannel.id,
        forumTagIds,
        tagRoleMap,
        escrowVerifiedRoleId: escrowVerifiedRole.id,
        escrowPanelChannelId: panelChannel.id,
        escrowLogChannelId: logChannel.id
    };

    guildSettingsMap.set(guild.id, guildConfig);
    await saveGuildSettings();

    await wishlistChannel.send(buildWishlistPanelMessage());
    await panelChannel.send(await buildEscrowPanelMessage());

    return guildConfig;
}

async function findMessageByIdAcrossGuilds(messageId) {

    for (const guild of client.guilds.cache.values()) {
        try {
            await guild.channels.fetch();
        } catch (error) {
            continue;
        }

        for (const channel of guild.channels.cache.values()) {
            if (!channel?.isTextBased?.()) continue;
            if (typeof channel.messages?.fetch !== 'function') continue;

            try {
                const message = await channel.messages.fetch(messageId);
                if (message) return message;
            } catch (error) {
                continue;
            }
        }
    }

    return null;
}

async function attachEscrowButtonToTargetMessage() {

    const targetChannel = await client.channels.fetch(TARGET_ESCROW_CHANNEL_ID).catch(() => null);

    if (!targetChannel?.isTextBased?.()) {
        console.warn(`인증 버튼을 붙일 대상 채널을 찾지 못했습니다: ${TARGET_ESCROW_CHANNEL_ID}`);
        return;
    }

    await targetChannel.send(await buildEscrowPanelMessage());
}


// ===== 태그 → 역할 연결 =====
const TAG_ROLE_MAP = {

    '1502715179593634013': '1502716546181496992', // 키 스킨
    '1502715222308425871': '1502716530943852695', // 크리스탈
    '1502715236828971168': '1502716547893035200', // 키퍼
    '1502715329288212743': '1502716549364977836', // 키낫
    '1502715355783757976': '1502716544323555348', // 아크 크로스보우
    '1502715401765912686': '1502729557071888595', // 고스팩
    '1502715456015040632': '1502729662089003140', // 종합계
    '1502715468920655983': '1502729710960906351', // 부계용
    '1502715503980843191': '1502716542192980029', // 발로란트
    '1503249502557962290': '1503251234751119430', // 아크 카타나
    '1503249695588220949': '1503251243655495801', // 아크 화염병
    '1503249460325777449': '1503258866962399303'  // 브롤스타즈
};


// ===== 기본 설정 =====
const LEGACY_WISHLIST_CHANNEL = '1502698841630052422';
const WISHLIST_CHANNEL = process.env.WISHLIST_CHANNEL_ID ?? LEGACY_WISHLIST_CHANNEL;
const TARGET_ESCROW_CHANNEL_ID = '1506159442415190016';
const ESCROW_START_BUTTON_ID = 'escrow_start';

const FORUM_CHANNEL = '1497580488859193354';

const PROMO_CHANNEL = '1502714588867854478';

const BROKER_COMMAND = new SlashCommandBuilder()
    .setName('broker')
    .setNameLocalizations({
        ko: '중개'
    })
    .setDescription('Create a brokerage guide message')
    .setDescriptionLocalizations({
        ko: '중개 안내 메시지를 생성합니다.'
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

const OYE_COMMAND = new SlashCommandBuilder()
    .setName('oye')
    .setNameLocalizations({
        ko: '오예'
    })
    .setDescription('Easter egg reply')
    .setDescriptionLocalizations({
        ko: '이스터에그 응답'
    })
    .setDMPermission(false);

const HIGH_VALUE_COMMAND = new SlashCommandBuilder()
    .setName('high_value')
    .setNameLocalizations({
        ko: '고액'
    })
    .setDescription('Create a high value trade guide message')
    .setDescriptionLocalizations({
        ko: '고액 거래 안내 메시지를 생성합니다.'
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

const SETTING_COMMAND = new SlashCommandBuilder()
    .setName('setting')
    .setDescription('Automatically configure wishlist and forum channels for this server')
    .setDescriptionLocalizations({
        ko: '이 서버의 위시리스트/포럼 기능을 자동으로 세팅합니다.'
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

const WISHLIST_PANEL_COMMAND = new SlashCommandBuilder()
    .setName('wishlist_panel')
    .setNameLocalizations({
        ko: '위시리스트'
    })
    .setDescription('Create a wishlist panel message in this channel')
    .setDescriptionLocalizations({
        ko: '현재 채널에 위시리스트 패널 메시지를 생성합니다.'
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

const ESCROW_SET_COMMAND = new SlashCommandBuilder()
    .setName('escrow_set')
    .setDescription('Set escrow email for this server')
    .addStringOption(opt => opt.setName('email').setDescription('Email to receive codes').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

const ESCROW_SEND_COMMAND = new SlashCommandBuilder()
    .setName('escrow_panel')
    .setNameLocalizations({
        ko: '인증'
    })
    .setDescription('Post the escrow verification panel in the current channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

const ESCROW_VERIFY_COMMAND = new SlashCommandBuilder()
    .setName('escrow_verify')
    .setDescription('Verify the code you received by Discord message')
    .addStringOption(opt => opt.setName('code').setDescription('6-digit code').setRequired(true))
    .setDMPermission(false);

const HIGH_VALUE_AGREE_BUTTON_ID = 'high_value:agree';
const HIGH_VALUE_DISAGREE_BUTTON_ID = 'high_value:disagree';
const BROKER_BUYER_BUTTON_ID = 'broker:buyer_input';
const BROKER_SELLER_BUTTON_ID = 'broker:seller_input';
const BROKER_MODAL_PREFIX = 'broker_modal';

const highValueStateMap = new Map();

function extractUserId(input) {

    const trimmed = input.trim();

    const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);

    if (mentionMatch) return mentionMatch[1];

    if (/^\d{15,20}$/.test(trimmed)) return trimmed;

    return null;
}

async function resolveBrokerMember(guild, input) {

    const trimmed = input.trim();

    const directId = extractUserId(trimmed);

    if (directId) {
        try {
            return await guild.members.fetch(directId);
        } catch {
            return null;
        }
    }

    const cacheMatches = guild.members.cache.filter(member =>
        member.user.username === trimmed ||
        member.displayName === trimmed ||
        member.nickname === trimmed
    );

    if (cacheMatches.size === 1) {
        return cacheMatches.first();
    }

    if (cacheMatches.size > 1) {
        const exactMatch = cacheMatches.find(member =>
            member.displayName === trimmed ||
            member.user.username === trimmed
        );

        if (exactMatch) return exactMatch;

        return null;
    }

    try {
        const fetchedMembers = await guild.members.fetch({ query: trimmed, limit: 10 });

        const exactMatch = fetchedMembers.find(member =>
            member.user.username === trimmed ||
            member.displayName === trimmed ||
            member.nickname === trimmed
        );

        if (exactMatch) return exactMatch;

        if (fetchedMembers.size === 1) {
            return fetchedMembers.first();
        }

        return null;
    } catch {
        return null;
    }
}

function buildBrokerPanelComponents(managerId, channelId) {

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${BROKER_BUYER_BUTTON_ID}:${managerId}:${channelId}`)
            .setLabel('구매자가 판매자 정보입력')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${BROKER_SELLER_BUTTON_ID}:${managerId}:${channelId}`)
            .setLabel('판매자가 구매자 정보 입력')
            .setStyle(ButtonStyle.Secondary)
    );

    return [buttonRow];
}

function buildBrokerModal(role, managerId, channelId) {

    const modal = new ModalBuilder()
        .setCustomId(`${BROKER_MODAL_PREFIX}:${role}:${managerId}:${channelId}`)
        .setTitle(role === 'buyer' ? '구매자가 판매자 정보입력' : '판매자가 구매자 정보입력');

    const input = new TextInputBuilder()
        .setCustomId('user_id')
        .setLabel('거래상대에 @멘션, 숫자 ID, 닉네임, 사용자명을 입력해주세요')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('@멘션, 숫자 ID, 닉네임, 사용자명');

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    return modal;
}

function buildBrokerContent(manager, buyer, seller) {

    const managerAccountMap = {
        '390406885075058692': 'NH농협지역조합 3522093635763',
        '914819736796270663': '토스 1908 9481 7287'
    };

    const accountText = managerAccountMap[manager.id] ?? '[담당자 계좌]';
    const managerMention = manager.toString();
    const buyerMention = buyer.toString();
    const sellerMention = seller.toString();

    return [
        `# 📌 거래 진행 안내\n\n### 담당자(${managerMention})\n담당자에 지시를 따라 주시길 바랍니다.`,
        `### 구매자(${buyerMention})\n먼저 **${accountText}** 로 입금 부탁드립니다.\n\n## ⚠️ 필수 안내\n\n반드시 **이중창(거래창 2개)**으로 진행해주세요.\n이중창 없이 진행할 경우 먹튀 및 3자사기 위험이 발생할 수 있습니다.\n\n만약 실수로 이중창 없이 송금하셨다면,\n즉시 은행에 반환 신청 부탁드립니다.\n(3자사기 방지 목적) (안하길 경우 금액은 돌려드리지 않습니다.)`,
        `━━━━━━━━━━━━━━━`,
        `### 판매자(${sellerMention})\n담당자가 입금 확인 완료 안내를 드리면, 채팅에 아래 정보를 보내주시면 됩니다.\n\n* 사용자명(ID)\n* 비밀번호(PW)\n\n계정의 이메일 및 비밀번호 확인과 변경이 정상적으로 완료되면, 판매자님 계좌로 금액을 전달해드립니다.`
    ];
}

function buildHighValueContent() {

    return `# :lock: 고액 거래 안내
5만원 이상의 거래는 안전한 거래 진행을 위해 본인 확인이 가능한 수단을 준비해주셔야 합니다.

## 가능한 인증 수단 예시
> - 학생증
> - 신분증
> - 전화번호
> - 기타 본인 확인 가능 정보
※ 인증 정보는 상대방이 아닌 어드민에게만 보여주셔도 됩니다.
━━━━━━━━━━━━━━━
상대방과 서로 신분 공개를 원하지 않을 경우, 양측이 모두 비동의 눌렀다면 인증 없이 진행 가능합니다.
-# 다만 사기 및 분쟁 방지를 위해 , 가급적 본인 인증 후 거래를 권장드립니다.`;
}

function buildHighValueComponents() {

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(HIGH_VALUE_AGREE_BUTTON_ID)
            .setLabel('동의')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(HIGH_VALUE_DISAGREE_BUTTON_ID)
            .setLabel('비동의')
            .setStyle(ButtonStyle.Danger)
    );

    return [buttonRow];
}

function buildHighValueVoteSummary(state) {

    const voteLines = [
        ...state.agreeUsers,
        ...state.disagreeUsers
    ].map(userId => `<@${userId}> 투표완료`);

    if (!voteLines.length) return '';

    return `\n\n## 투표 완료\n${voteLines.join('\n')}`;
}

function renderHighValueContent(state, mode = 'pending') {

    let content = buildHighValueContent();

    if (mode === 'agree') {
        content = strikeHighValueLine(
            content,
            '상대방과 서로 신분 공개를 원하지 않을 경우, 양측이 모두 비동의 눌렀다면 인증 없이 진행 가능합니다.'
        );
    }

    if (mode === 'withdrawn') {
        content = content
            .split('\n')
            .map((line, index) => {
                if (index === 0) {
                    return '# :lock: 고액 거래 안내 (철회 됨)';
                }

                if (line.trim().length === 0) return line;

                return `~~${line}~~`;
            })
            .join('\n');
    }

    return `${content}${buildHighValueVoteSummary(state)}`;
}

function strikeHighValueLine(content, targetLine) {

    return content
        .split('\n')
        .map(line => {
            if (line.trim().length === 0) return line;
            if (line === targetLine) return `~~${line}~~`;
            return line;
        })
        .join('\n');
}

function strikeHighValueExceptLine(content, keepLine) {

    return content
        .split('\n')
        .map(line => {
            if (line.trim().length === 0) return line;
            if (line === keepLine) return line;
            return `~~${line}~~`;
        })
        .join('\n');
}


// ===== 봇 실행 =====
client.once(Events.ClientReady, async () => {

    console.log(`${client.user.tag} 로그인 성공`);

    await loadGuildSettings();
    await loadEscrowConfig();
    await loadEscrowCodes();
    await cleanupEscrowTemporaryNoticesAtStartup();
    startEscrowTemporaryNoticeSweeper();
    // 자동으로 패널을 게시하지 않습니다. 필요한 경우 /인증 또는 /위시리스트 명령어로 게시하세요.
    await startEscrowMailboxWatcher();

    try {
        if (client.application) {
            const globalCommands = await client.application.commands.fetch();

            for (const command of globalCommands.values()) {
                await client.application.commands.delete(command.id);
            }
        }
    } catch (e) {
        console.error('전역 명령어 초기화 실패:', e);
    }

    // 전역 등록 대신 길드(서버)별로 명령어를 등록하면 즉시 반영됩니다.
    for (const guild of client.guilds.cache.values()) {
        try {
            await registerGuildCommands(guild);
        } catch (e) {
            console.error('길드 명령어 등록 실패:', e);
        }
    }
});

client.on(Events.GuildCreate, async guild => {

    try {
        await registerGuildCommands(guild);
    } catch (error) {
        console.error('신규 길드 명령어 등록 실패:', error);
    }
});


// ===== 역할 선택 =====
client.on(Events.InteractionCreate, async interaction => {

    try {
    const member = interaction.member;

    if (interaction.isButton()) {
        if (interaction.customId.startsWith(`${BROKER_BUYER_BUTTON_ID}:`) || interaction.customId.startsWith(`${BROKER_SELLER_BUTTON_ID}:`)) {
            const [namespace, action, managerId, channelId] = interaction.customId.split(':');
            const role = action === 'buyer_input' ? 'buyer' : 'seller';

            if (namespace !== 'broker' || !managerId || !channelId) {
                await replyEphemeral(interaction, {
                    content: '중개 패널 정보를 불러오지 못했습니다. 다시 /중개를 입력해 주세요.'
                });

                return;
            }

            await interaction.showModal(buildBrokerModal(role, managerId, channelId));
            return;
        }

        if (interaction.customId === WISHLIST_SEARCH_BUTTON_ID) {
            const guild = interaction.guild;

            if (!guild) {
                await replyEphemeral(interaction, { content: '서버에서만 사용할 수 있습니다.' });
                return;
            }

            const wishlistRoleIds = new Set(
                Object.keys(ROLES)
                    .map(k => resolveWishlistRole(guild, k)?.id)
                    .filter(Boolean)
            );

            const hasAny = member.roles.cache.some(r => wishlistRoleIds.has(r.id));

            if (!hasAny) {
                await replyEphemeral(interaction, {
                    content: '검색은 위시리스트 역할 보유자만 사용할 수 있습니다.'
                });

                return;
            }

            await interaction.showModal(buildWishlistSearchModal());
            return;
        }

        if (interaction.customId === ESCROW_START_BUTTON_ID) {
            const guild = interaction.guild;

            if (!guild) {
                await replyEphemeral(interaction, { content: '서버에서만 사용할 수 있습니다.' });
                return;
            }

            const lastPressedAt = escrowButtonCooldownMap.get(interaction.user.id) ?? 0;
            const cooldownRemaining = ESCROW_BUTTON_COOLDOWN_MS - (Date.now() - lastPressedAt);

            if (cooldownRemaining > 0) {
                const remainingSeconds = Math.ceil(cooldownRemaining / 1000);

                await replyEphemeral(interaction, {
                    content: `인증 버튼은 ${remainingSeconds}초 후에 다시 사용할 수 있습니다.`
                });

                return;
            }

            escrowButtonCooldownMap.set(interaction.user.id, Date.now());

            await deferEphemeralReply(interaction);

            const code = generateCode();
            const expiresAt = Date.now() + 5 * 60 * 1000;
            escrowCodeMap.set(interaction.user.id, { code, expiresAt, guildId: guild.id, channelId: interaction.channelId });
            await saveEscrowCodes();
            escrowPendingMessageMap.set(interaction.user.id, {
                code,
                expiresAt,
                guildId: guild.id,
                channelId: interaction.channelId
            });

            await interaction.editReply({
                content: `SMS 문자 메시지로 아래 인증코드를 [${DEFAULT_ESCROW_EMAIL}] 으로 보내주시면 됩니다.\n\n## 인증코드 : [ ${code} ]\n\n-# 해당 인증코드는 5분 동안 유효합니다.`
            });
            return;
        }

        if (interaction.customId === HIGH_VALUE_AGREE_BUTTON_ID || interaction.customId === HIGH_VALUE_DISAGREE_BUTTON_ID) {
            // 기존 고액 버튼 처리 로직은 아래에서 계속 처리
        }
    }

    if (interaction.isModalSubmit() && interaction.customId === WISHLIST_SEARCH_MODAL_ID) {
        const searchQuery = interaction.fields.getTextInputValue('search_query');
        const guild = interaction.guild;

        if (!guild) {
            await replyEphemeral(interaction, {
                content: '서버에서만 사용할 수 있습니다.'
            });

            return;
        }

        const matches = findWishlistMatches(guild, searchQuery);

        if (!matches.length) {
            await replyEphemeral(interaction, {
                content: `"${searchQuery}"에 해당하는 위시리스트 상품을 찾지 못했습니다.`,
                components: []
            });

            return;
        }

        const searchMenu = buildWishlistSearchResultMenu(matches, searchQuery);

        const guildConfig = getGuildConfig(guild.id);
        const forumMention = guildConfig?.forumChannelId ? `<#${guildConfig.forumChannelId}>` : '거래 포럼 채널';

        await replyEphemeral(interaction, {
            content: `## 검색 결과\n"${searchQuery}"에 대한 위시리스트 항목입니다.\n해당 상품은 ${forumMention} 채널에 있습니다.`,
            components: [
                new ActionRowBuilder().addComponents(searchMenu)
            ]
        });

        return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(`${BROKER_MODAL_PREFIX}:`)) {
        const [, role, managerId, channelId] = interaction.customId.split(':');

        if (!managerId || !channelId) {
            await replyEphemeral(interaction, {
                content: '중개 패널 정보를 불러오지 못했습니다. 다시 /중개를 입력해 주세요.'
            });

            return;
        }

        const enteredText = interaction.fields.getTextInputValue('user_id');

        if (!enteredText?.trim()) {
            await replyEphemeral(interaction, {
                content: '사용자 아이디 형식이 올바르지 않습니다. 다시 시도해 주세요.'
            });

            return;
        }

        const guild = interaction.guild;

        if (!guild) {
            await replyEphemeral(interaction, {
                content: '서버에서만 사용할 수 있습니다.'
            });

            return;
        }

        const enteredMember = await resolveBrokerMember(guild, enteredText);

        if (!enteredMember) {
            await replyEphemeral(interaction, {
                content: '해당 사용자 아이디를 찾을 수 없습니다. @멘션, 숫자 ID, 닉네임, 사용자명으로 다시 시도해 주세요.'
            });

            return;
        }

        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);

        if (!targetChannel?.isTextBased()) {
            await replyEphemeral(interaction, {
                content: '중개 채널을 찾지 못했습니다. 다시 /중개를 입력해 주세요.'
            });

            return;
        }

        await targetChannel.permissionOverwrites.edit(enteredMember.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
        });

        const manager = await client.users.fetch(managerId);
        const buyer = role === 'buyer' ? interaction.user : enteredMember.user;
        const seller = role === 'buyer' ? enteredMember.user : interaction.user;
        const parts = buildBrokerContent(manager, buyer, seller);

        await targetChannel.send({ content: parts[0] });
        await targetChannel.send({ content: parts[1] });
        await targetChannel.send({ content: parts[2] });
        await targetChannel.send({ content: parts[3] });

        await replyEphemeral(interaction, {
            content: '중개 안내를 전송했습니다.'
        });

        return;
    }

    if (interaction.isChatInputCommand()) {

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
            !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            if (interaction.commandName === 'broker' || interaction.commandName === 'high_value' || interaction.commandName === 'wishlist_panel' || interaction.commandName === 'setting') {
                await replyEphemeral(interaction, {
                    content: '서버 관리자만 사용할 수 있습니다.'
                });

                return;
            }
        }

        // --- Escrow commands ---
        if (interaction.commandName === 'escrow_set') {
            const guild = interaction.guild;

            if (!guild) {
                await replyEphemeral(interaction, { content: '서버에서만 사용할 수 있습니다.' });
                return;
            }

            const email = interaction.options.getString('email', true).trim();

            escrowConfigMap.set(guild.id, { email });
            await saveEscrowConfig();

            await replyEphemeral(interaction, { content: `에스크로 이메일을 ${email} 으로 설정했습니다.` });
            return;
        }

        if (interaction.commandName === 'escrow_panel') {
            const guild = interaction.guild;

            if (!guild) {
                await replyEphemeral(interaction, { content: '서버에서만 사용할 수 있습니다.' });
                return;
            }

            const channel = interaction.channel;

            if (!channel?.isTextBased?.()) {
                await replyEphemeral(interaction, { content: '채팅이 가능한 채널에서만 사용할 수 있습니다.' });
                return;
            }

            await channel.send(await buildEscrowPanelMessage());
            await replyEphemeral(interaction, { content: '인증 패널을 게시했습니다.' });
            return;
        }

        if (interaction.commandName === 'escrow_verify') {
            const guild = interaction.guild;

            if (!guild) {
                await replyEphemeral(interaction, { content: '서버에서만 사용할 수 있습니다.' });
                return;
            }

            await deferEphemeralReply(interaction);

            const provided = interaction.options.getString('code', true).trim();
            const stored = escrowCodeMap.get(interaction.user.id);

            if (!stored || stored.guildId !== guild.id) {
                await interaction.editReply({ content: '인증 코드가 없습니다. 먼저 패널의 인증 버튼을 눌러 코드를 발송하세요.' });
                return;
            }

            if (Date.now() > stored.expiresAt) {
                escrowCodeMap.delete(interaction.user.id);
                await saveEscrowCodes();
                await interaction.editReply({ content: '인증 코드가 만료되었습니다. 다시 요청하세요.' });
                return;
            }

            if (stored.code !== provided) {
                // 코드 오류 시 알림 메시지 (1분 후 삭제)
                try {
                    const errorChannel = await client.channels.fetch(TARGET_ESCROW_CHANNEL_ID).catch(() => null);

                    if (errorChannel?.isTextBased?.()) {
                        await sendEscrowTemporaryNotice(errorChannel, `<@${interaction.user.id}> 인증코드가 일치하지 않습니다.`);
                    }
                } catch (e) {
                    console.error('오류 알림 전송 실패:', e);
                }

                await interaction.editReply({ content: '인증 코드가 일치하지 않습니다.' });
                return;
            }

            // 인증 성공: 거래인증 역할 부여
            let guildConfig = getGuildConfig(guild.id);
            let roleId = guildConfig?.escrowVerifiedRoleId ?? null;

            let roleObj = roleId ? guild.roles.cache.get(roleId) : null;

            if (!roleObj) {
                // 만든 적이 없다면 생성
                roleObj = await guild.roles.create({ name: '거래인증', reason: '에스크로 인증 역할 생성' });
                guildConfig = Object.assign({}, guildConfig, { escrowVerifiedRoleId: roleObj.id });
                guildSettingsMap.set(guild.id, guildConfig);
                await saveGuildSettings();
            }

            await interaction.member.roles.add(roleObj.id).catch(() => null);

            escrowCodeMap.delete(interaction.user.id);
            await saveEscrowCodes();

            await interaction.editReply({ content: '인증 성공: 거래포럼 이용 권한이 부여되었습니다.' });
            return;
        }

        if (interaction.commandName === 'broker') {
            if (!interaction.channel?.isTextBased()) {
                await replyEphemeral(interaction, {
                    content: '채팅이 가능한 채널에서만 사용할 수 있습니다.'
                });

                return;
            }

            await interaction.reply({
                content: '# :pushpin: 거래 진행 안내\n\n거래 진행을 위해 아래 버튼을 눌러 정보를 입력해주세요.\n\n> 구매자 ➜ **구매자가 판매자 정보입력**\n> 판매자 ➜ **판매자가 구매자 정보입력**\n\n본인 역할에 맞는 버튼만 눌러주시면 됩니다.\n다른 버튼을 잘못 누르지 않도록 주의해주세요. :pray:',
                components: buildBrokerPanelComponents(interaction.user.id, interaction.channelId)
            });

            return;
        }

        if (interaction.commandName === 'oye') {
            await interaction.reply({
                content: '멍청이'
            });

            return;
        }

        if (interaction.commandName === 'high_value') {
            try {
                await interaction.deferReply();

                const messageContent = buildHighValueContent();

                const sentMessage = await interaction.editReply({
                    content: messageContent,
                    components: buildHighValueComponents()
                });

                highValueStateMap.set(sentMessage.id, {
                    originalContent: messageContent,
                    agreeUsers: new Set(),
                    disagreeUsers: new Set(),
                    locked: false
                });
            } catch (error) {
                console.error('고액 명령 처리 실패:', error);

                if (!interaction.replied && !interaction.deferred) {
                    await replyEphemeral(interaction, {
                        content: '고액 거래 안내를 생성하지 못했습니다.'
                    });
                } else {
                    await interaction.editReply({
                        content: '고액 거래 안내를 생성하지 못했습니다.',
                        components: []
                    });
                }
            }

            return;
        }

        if (interaction.commandName === 'wishlist_panel') {
            if (!interaction.channel?.isTextBased()) {
                await replyEphemeral(interaction, {
                    content: '채팅이 가능한 채널에서만 사용할 수 있습니다.'
                });

                return;
            }

            await interaction.channel.send(buildWishlistPanelMessage());

            await replyEphemeral(interaction, {
                content: '현재 채널에 위시리스트 패널을 생성했습니다.'
            });

            return;
        }

        if (interaction.commandName === 'setting') {
            const guild = interaction.guild;

            if (!guild) {
                await replyEphemeral(interaction, {
                    content: '서버에서만 사용할 수 있습니다.'
                });

                return;
            }

            await deferEphemeralReply(interaction);

            try {
                const guildConfig = await setupGuild(guild);

                await interaction.editReply({
                    content: [
                        '자동 세팅 완료',
                        `- 위시리스트 채널: <#${guildConfig.wishlistChannelId}>`,
                        `- 거래 포럼 채널: <#${guildConfig.forumChannelId}>`,
                        `- 홍보알림 채널: <#${guildConfig.promoChannelId}>`,
                        `- 인증 패널 채널: <#${guildConfig.escrowPanelChannelId}>`,
                        `- 인증로그 채널: <#${guildConfig.escrowLogChannelId}>`,
                        `- 거래인증 역할: <@&${guildConfig.escrowVerifiedRoleId}>`,
                        '- 위시리스트 역할/포럼 태그도 함께 세팅되었습니다.'
                    ].join('\n')
                });
            } catch (error) {
                console.error('자동 세팅 실패:', error);

                await interaction.editReply({
                    content: '자동 세팅에 실패했습니다. 봇 권한(역할 관리/채널 관리)을 확인해 주세요.'
                });
            }

            return;
        }
    }

    // 드롭다운 처리
    if (interaction.isStringSelectMenu()) {

        if (interaction.customId === WISHLIST_CATEGORY_SELECT_ID) {

            const selectedCategory = interaction.values[0];
            const itemMenu = buildItemMenu(interaction.guild, selectedCategory);

            if (!itemMenu) {
                await replyEphemeral(interaction, {
                    content: '이 서버에서 선택 가능한 위시리스트 역할이 없습니다.'
                });

                return;
            }

            await replyEphemeral(interaction, {
                content: `## ${WISHLIST_CATEGORIES[selectedCategory].label}\n원하는 위시리스트를 선택하세요.`,
                components: [
                    new ActionRowBuilder().addComponents(itemMenu)
                ]
            });

            return;
        }

        if (interaction.customId.startsWith(WISHLIST_SEARCH_RESULT_PREFIX)) {
            await deferEphemeralReply(interaction);

            const guild = interaction.guild;

            if (!guild) {
                await interaction.editReply({
                    content: '서버에서만 사용할 수 있습니다.'
                });

                return;
            }

            const selected = parseWishlistSelectionValue(interaction.values[0]);

            if (!selected || !ROLES[selected.itemKey]) {
                await interaction.editReply({
                    content: '선택한 검색 결과를 처리할 수 없습니다.'
                });

                return;
            }

            const selectedRole = resolveWishlistRole(guild, selected.itemKey);

            if (!selectedRole) {
                await interaction.editReply({
                    content: '선택한 상품 역할을 찾을 수 없습니다.'
                });

                return;
            }

            if (member.roles.cache.has(selectedRole.id)) {
                await interaction.editReply({
                    content: `${WISHLIST_CATEGORIES[selected.categoryKey].label} - ${ROLES[selected.itemKey].label} 역할은 이미 등록되어 있습니다.`
                });

                return;
            }

            await member.roles.add(selectedRole.id);

            await interaction.editReply({
                content: `${WISHLIST_CATEGORIES[selected.categoryKey].label} - ${ROLES[selected.itemKey].label} 위시리스트 등록 완료`
            });

            return;
        }

        if (!interaction.customId.startsWith(WISHLIST_ITEM_SELECT_PREFIX)) return;

        await deferEphemeralReply(interaction);

        const categoryKey = interaction.customId.slice(WISHLIST_ITEM_SELECT_PREFIX.length);
        const selected = interaction.values[0];
        const guild = interaction.guild;

        if (!guild) {
            await interaction.editReply({
                content: '서버에서만 사용할 수 있습니다.'
            });

            return;
        }

        const categoryRoles = getCategoryRoles(guild, categoryKey);
        const selectedRole = resolveWishlistRole(guild, selected);

        if (!categoryRoles.length || !ROLES[selected] || !selectedRole) {
            await interaction.editReply({
                content: '선택한 위시리스트를 처리할 수 없습니다.'
            });

            return;
        }

        if (member.roles.cache.has(selectedRole.id)) {
            await interaction.editReply({
                content: `${WISHLIST_CATEGORIES[categoryKey].label} - ${ROLES[selected].label} 역할은 이미 등록되어 있습니다.`
            });

            return;
        }

        await member.roles.add(selectedRole.id);

        await interaction.editReply({
            content: `${WISHLIST_CATEGORIES[categoryKey].label} - ${ROLES[selected].label} 위시리스트 등록 완료`
        });

        return;
    }

    // 역할 초기화
    if (interaction.isButton()) {

        if (interaction.customId === HIGH_VALUE_AGREE_BUTTON_ID || interaction.customId === HIGH_VALUE_DISAGREE_BUTTON_ID) {

            const highValueState = highValueStateMap.get(interaction.message.id);

            if (!highValueState || highValueState.locked) {
                await replyEphemeral(interaction, {
                    content: '이 고액 거래 안내는 더 이상 수정할 수 없습니다.'
                });

                return;
            }

            const userId = interaction.user.id;

            if (highValueState.agreeUsers.has(userId) || highValueState.disagreeUsers.has(userId)) {
                await replyEphemeral(interaction, {
                    content: '한 명당 한 번만 투표할 수 있습니다.'
                });

                return;
            }

            if (interaction.customId === HIGH_VALUE_AGREE_BUTTON_ID) {
                highValueState.agreeUsers.add(userId);
                highValueState.locked = true;

                await interaction.update({
                    content: renderHighValueContent(highValueState, 'agree'),
                    components: []
                });

                highValueStateMap.delete(interaction.message.id);

                return;
            }

            highValueState.disagreeUsers.add(userId);

            if (highValueState.disagreeUsers.size >= 2) {
                highValueState.locked = true;

                await interaction.update({
                    content: renderHighValueContent(highValueState, 'withdrawn'),
                    components: []
                });

                highValueStateMap.delete(interaction.message.id);

                return;
            }

            await interaction.update({
                content: renderHighValueContent(highValueState, 'pending'),
                components: buildHighValueComponents()
            });

            return;
        }

        if (interaction.customId !== 'reset_roles') return;

        await deferEphemeralReply(interaction);

        const guild = interaction.guild;

        if (!guild) {
            await interaction.editReply({
                content: '서버에서만 사용할 수 있습니다.'
            });

            return;
        }

        const wishlistRoleIds = new Set(
            Object.keys(ROLES)
                .map(itemKey => resolveWishlistRole(guild, itemKey)?.id)
                .filter(Boolean)
        );

        const removeRoles = member.roles.cache.filter(role =>
            wishlistRoleIds.has(role.id)
        );

        if (!removeRoles.size) {
            await interaction.editReply({
                content: '제거할 위시리스트 역할이 없습니다.'
            });

            return;
        }

        await member.roles.remove(removeRoles);

        await interaction.editReply({
            content: '위시리스트 역할 제거 완료'
        });
    }
    } catch (error) {
        console.error('인터랙션 처리 실패:', error);

        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: '요청 처리 중 오류가 발생했습니다.'
                });
            } else if (interaction.isRepliable()) {
                await interaction.reply({
                    content: '요청 처리 중 오류가 발생했습니다.',
                    flags: EPHEMERAL_FLAGS
                });
            }
        } catch (replyError) {
            console.error('오류 응답 전송 실패:', replyError);
        }
    }
});

// ===== 포럼 자동 홍보 =====
// 스레드 ID와 홍보 메시지 ID 매핑
const threadPromoMap = new Map();

const FORUM_TAG_IDS = {
    forSale: '1503250339871068291',
    lookingFor: '1503250934443151370',
    trade: '1503813224322174996'
};

function getLegacyGuildConfig() {

    return {
        wishlistChannelId: WISHLIST_CHANNEL,
        forumChannelId: FORUM_CHANNEL,
        promoChannelId: PROMO_CHANNEL,
        forumTagIds: FORUM_TAG_IDS,
        tagRoleMap: TAG_ROLE_MAP,
        escrowVerifiedRoleId: null,
        escrowPanelChannelId: null,
        escrowLogChannelId: null
    };
}

function getGuildConfig(guildId) {

    if (guildSettingsMap.has(guildId)) {
        return guildSettingsMap.get(guildId);
    }

    return getLegacyGuildConfig();
}

function shouldSendForumPromo(appliedTags, forumTagIds) {

    if (!forumTagIds?.forSale || !forumTagIds?.lookingFor || !forumTagIds?.trade) {
        return false;
    }

    if (appliedTags.includes(forumTagIds.lookingFor) || appliedTags.includes(forumTagIds.trade)) {
        return false;
    }

    if (!appliedTags.includes(forumTagIds.forSale)) {
        return false;
    }

    return appliedTags.some(tagId =>
        tagId !== forumTagIds.forSale &&
        tagId !== forumTagIds.lookingFor &&
        tagId !== forumTagIds.trade
    );
}

async function sendForumPromo(thread, guildConfig) {

    if (!guildConfig?.promoChannelId || !guildConfig?.tagRoleMap) return;

    const promoChannel = await client.channels.fetch(guildConfig.promoChannelId).catch(() => null);

    if (!promoChannel?.isTextBased()) return;

    const roleMentions = [];

    for (const tagId of thread.appliedTags) {

        const roleId = guildConfig.tagRoleMap[tagId];

        if (!roleId) continue;

        roleMentions.push(`<@&${roleId}>`);
    }

    const uniqueMentions = [...new Set(roleMentions)];

    if (uniqueMentions.length === 0) return;

    const promoMessage = await promoChannel.send({

        content:
`## [🔔] ${thread} 게시글에 ${uniqueMentions.join(' ')} 재고가 새롭게 등록되었습니다.

-# 자세한 내용은 ${thread} 게시글에서 확인해주세요.
`

    });

    threadPromoMap.set(thread.id, {
        messageId: promoMessage.id,
        promoChannelId: promoChannel.id,
        mentions: uniqueMentions,
        title: thread.name
    });
}

async function markForumPromoSoldOut(thread) {

    const promoData = threadPromoMap.get(thread.id);

    if (!promoData) return;

    try {
        const guildConfig = thread.guildId ? getGuildConfig(thread.guildId) : null;
        const targetPromoChannelId = promoData.promoChannelId ?? guildConfig?.promoChannelId;

        if (!targetPromoChannelId) return;

        const promoChannel = await client.channels.fetch(targetPromoChannelId);
        const promoMessage = await promoChannel.messages.fetch(promoData.messageId);

        const updatedContent = `❌ SOLD OUT ❌

이 상품은 판매되었습니다.

게시글: ${promoData.title}
상품종류: ${promoData.mentions.join(' ')}`;

        await promoMessage.edit({
            content: updatedContent
        });

        threadPromoMap.delete(thread.id);
    } catch (error) {
        console.error('홍보 메시지 편집 실패:', error);
    }
}

client.on(Events.ThreadCreate, async thread => {

    const guildConfig = getGuildConfig(thread.guildId);

    if (!guildConfig?.forumChannelId || thread.parentId !== guildConfig.forumChannelId) return;

    // 구해요/교환해요가 있거나, 팔아요 외 추가 태그가 없으면 홍보 안 함
    if (!shouldSendForumPromo(thread.appliedTags, guildConfig.forumTagIds)) return;

    await sendForumPromo(thread, guildConfig);
});

client.on(Events.ThreadUpdate, async (oldThread, newThread) => {

    const guildConfig = getGuildConfig(newThread.guildId);

    if (!guildConfig?.forumChannelId || newThread.parentId !== guildConfig.forumChannelId) return;

    if (newThread.locked || newThread.archived) {
        await markForumPromoSoldOut(newThread);
        return;
    }

    if (!shouldSendForumPromo(newThread.appliedTags, guildConfig.forumTagIds)) return;

    if (threadPromoMap.has(newThread.id)) return;

    const tagsChanged =
        oldThread.appliedTags.length !== newThread.appliedTags.length ||
        oldThread.appliedTags.some(tagId => !newThread.appliedTags.includes(tagId));

    if (!tagsChanged) return;

    await sendForumPromo(newThread, guildConfig);
});

// 스레드 삭제 이벤트
client.on(Events.ThreadDelete, async thread => {

    const guildConfig = getGuildConfig(thread.guildId);

    if (!guildConfig?.forumChannelId || thread.parentId !== guildConfig.forumChannelId) return;

    await markForumPromoSoldOut(thread);
});

client.login(process.env.TOKEN);