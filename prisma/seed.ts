/**
 * LINKUPCHAT demo/seed data (Section 35).
 *
 * DEVELOPMENT ONLY — this script creates demo users with a publicly known
 * password ("linkup123") and wipes existing data. It refuses to run in
 * production unless ALLOW_DEMO_SEED=true is explicitly set.
 *
 * Run with: npm run db:seed
 *
 * Demo accounts (password for all): linkup123
 *   alex, sarah, daniel, emma, michael, jay, sophia, admin
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// ── Production guard: demo credentials must never reach production ──
const isProduction = process.env.NODE_ENV === 'production';
const forceAllowed = process.env.ALLOW_DEMO_SEED === 'true';
if (isProduction && !forceAllowed) {
  console.error(
    '⛔ Refusing to seed demo data in production.\n' +
      '   Demo credentials (linkup123) are for development only.\n' +
      '   If you REALLY know what you are doing, set ALLOW_DEMO_SEED=true.'
  );
  process.exit(1);
}

const db = new PrismaClient();

const AVATAR_COLORS: Record<string, string> = {
  alex: '#6D5EF5',
  sarah: '#FF6B5E',
  daniel: '#22C77D',
  emma: '#F5A623',
  michael: '#22B8FF',
  jay: '#8481FB',
  sophia: '#FF8A7A'
};

async function main() {
  console.log('🌱 Seeding LINKUPCHAT demo data…');

  // Clean demo data (dev only!)
  await db.$transaction([
    db.statusView.deleteMany(),
    db.status.deleteMany(),
    db.messageReaction.deleteMany(),
    db.attachment.deleteMany(),
    db.message.deleteMany(),
    db.call.deleteMany(),
    db.notification.deleteMany(),
    db.report.deleteMany(),
    db.blockedUser.deleteMany(),
    db.conversationMember.deleteMany(),
    db.conversation.deleteMany(),
    db.contact.deleteMany(),
    db.session.deleteMany(),
    db.passwordReset.deleteMany(),
    db.verificationToken.deleteMany(),
    db.loginEvent.deleteMany(),
    db.userSettings.deleteMany(),
    db.user.deleteMany()
  ]);

  const passwordHash = await bcrypt.hash('linkup123', 12);

  const profiles = [
    { username: 'alex', displayName: 'Alex Mensah', about: 'Building the future, one chat at a time 🚀' },
    { username: 'sarah', displayName: 'Sarah Okafor', about: 'Coffee first. Then everything else ☕' },
    { username: 'daniel', displayName: 'Daniel Adeyemi', about: 'Photographer. Storyteller. Dreamer 📸' },
    { username: 'emma', displayName: 'Emma Boateng', about: 'Dancing through life 💃' },
    { username: 'michael', displayName: 'Michael Asante', about: 'Runner. Coder. Human being.' },
    { username: 'jay', displayName: 'Jay Nkrumah', about: 'Music is my love language 🎵' },
    { username: 'sophia', displayName: 'Sophia Diallo', about: 'Hey there! I am using LINKUPCHAT.' },
    { username: 'admin', displayName: 'LINKUP Admin', about: 'Keeping LINKUPCHAT safe and kind.', role: 'ADMIN' as const }
  ];

  const users: Record<string, { id: string; displayName: string }> = {};

  for (const p of profiles) {
    const user = await db.user.create({
      data: {
        username: p.username,
        displayName: p.displayName,
        email: `${p.username}@linkupchat.demo`,
        passwordHash,
        about: p.about,
        role: ('role' in p ? (p as { role: 'ADMIN' }).role : 'USER') as 'USER' | 'ADMIN',
        emailVerifiedAt: new Date(),
        lastSeenAt: new Date(Date.now() - Math.floor(Math.random() * 3600_000)),
        isOnline: p.username === 'sarah' || p.username === 'sophia',
        settings: {
          create: {
            privacyStatus: 'CONTACTS',
            notifSounds: true
          }
        }
      }
    });
    users[p.username] = { id: user.id, displayName: p.displayName };
    console.log(`  👤 ${user.displayName} (@${user.username}) — ${AVATAR_COLORS[p.username] ?? '#6D5EF5'}`);
  }

  const alex = users.alex!;

  // ── Contacts (everyone connected to alex) ──
  for (const other of ['sarah', 'daniel', 'emma', 'michael', 'jay', 'sophia']) {
    await db.contact.create({
      data: { ownerId: alex.id, contactId: users[other]!.id }
    });
    await db.contact.create({
      data: { ownerId: users[other]!.id, contactId: alex.id }
    });
  }
  await db.contact.create({ data: { ownerId: users.sarah!.id, contactId: users.sophia!.id } });
  await db.contact.create({ data: { ownerId: users.sophia!.id, contactId: users.sarah!.id } });

  const now = Date.now();
  const mins = (m: number) => new Date(now - m * 60_000);

  async function direct(a: keyof typeof users, b: keyof typeof users, messages: [string, keyof typeof users, number, ('READ' | 'DELIVERED' | 'SENT')?][], opts?: { pinned?: boolean }) {
    const directKey = [users[a]!.id, users[b]!.id].sort().join(':');
    const conv = await db.conversation.create({
      data: {
        type: 'DIRECT',
        directKey,
        createdBy: users[a]!.id,
        lastMessageAt: messages.length ? mins(Math.min(...messages.map((m) => m[2]))) : undefined,
        members: {
          create: [
            { userId: users[a]!.id, isPinned: opts?.pinned ?? false, lastReadAt: mins(1) },
            { userId: users[b]!.id, lastReadAt: mins(1) }
          ]
        }
      }
    });

    for (const [content, sender, minutesAgo] of messages) {
      await db.message.create({
        data: {
          conversationId: conv.id,
          senderId: users[sender]!.id,
          type: 'TEXT',
          content,
          createdAt: mins(minutesAgo)
        }
      });
    }
    return conv;
  }

  // ── 1:1 conversations ──
  await direct('alex', 'sarah', [
    ['Hey Sarah! Are we still on for the team sync later?', 'alex', 180],
    ['Absolutely! I finished the deck this morning', 'sarah', 175],
    ['Amazing 🙌 You are a lifesaver', 'alex', 170],
    ['Haha anytime! Should we invite the rest of the crew?', 'sarah', 165],
    ['Good idea — I will add Michael and Emma to a group', 'alex', 160],
    ['Perfect. See you at 4!', 'sarah', 155],
    ['Looking forward to it ✨', 'alex', 32]
  ], { pinned: true });

  await direct('alex', 'sophia', [
    ['Just saw the photos from Saturday — they look incredible!', 'alex', 90],
    ['Right?? Daniel really outdid himself this time', 'sophia', 87],
    ['The one by the water is my favourite 😍', 'alex', 85],
    ['Same! I set it as my wallpaper haha', 'sophia', 80],
    ['😂😂 that is so you', 'alex', 78],
    ['Are you coming to Jay’s set on Friday?', 'sophia', 25],
    ['100%! Would not miss it 🎵', 'alex', 20]
  ]);

  await direct('alex', 'daniel', [
    ['Bro these edits are insane 🔥', 'alex', 300],
    ['Thank you! Spent all weekend on them', 'daniel', 295],
    ['It shows. The colour grading is *chefs kiss*', 'alex', 290],
    ['Means a lot coming from you 🙏', 'daniel', 285]
  ]);

  await direct('alex', 'emma', [
    ['Did you get the tickets?', 'emma', 500],
    ['Yes! Front row 🎉', 'alex', 495],
    ['NO WAY. You are the best!', 'emma', 490],
    ['😂❤️', 'alex', 488]
  ]);

  await direct('alex', 'michael', [
    ['Run tomorrow at 6?', 'michael', 1400],
    ['Make it 6:30 and you have a deal', 'alex', 1390],
    ['Deal 🤝', 'michael', 1385]
  ]);

  await direct('alex', 'jay', [
    ['Your new track is on repeat over here 🎧', 'alex', 2600],
    ['Haha thank you!! Studio this weekend to finish the EP', 'jay', 2590],
    ['Let me know when it drops', 'alex', 2585]
  ]);

  // ── Group conversation ──
  const group = await db.conversation.create({
    data: {
      type: 'GROUP',
      title: 'Weekend Crew 🎉',
      description: 'Plans, memes and good vibes only.',
      createdBy: alex.id,
      lastMessageAt: mins(12),
      members: {
        create: [
          { userId: alex.id, role: 'ADMIN', isPinned: true, lastReadAt: mins(5) },
          { userId: users.sarah!.id, role: 'ADMIN', lastReadAt: mins(10) },
          { userId: users.daniel!.id, lastReadAt: mins(40) },
          { userId: users.emma!.id, lastReadAt: mins(2) },
          { userId: users.sophia!.id, lastReadAt: mins(8) }
        ]
      }
    }
  });

  const groupMessages: [string, keyof typeof users, number][] = [
    ['Created the group 🎉', 'alex', 600],
    ['Who is in for the beach on Saturday?', 'sarah', 320],
    ['Me!! 🙋‍♀️', 'emma', 315],
    ['I can drive everyone', 'daniel', 310],
    ['Legend 🙏 What time are we thinking?', 'alex', 305],
    ['10am? Beat the heat', 'sarah', 300],
    ['Works for me', 'sophia', 295],
    ['Should we do a bonfire after sunset?', 'emma', 120],
    ['YES 🔥 I will bring the speaker', 'jay', 0]
  ];
  // jay not a member — adjust
  groupMessages[8] = ['YES 🔥 I will bring the speaker', 'emma', 12];

  for (const [content, sender, minutesAgo] of groupMessages) {
    await db.message.create({
      data: {
        conversationId: group.id,
        senderId: users[sender]!.id,
        type: 'TEXT',
        content,
        createdAt: mins(minutesAgo)
      }
    });
  }

  // Reactions on the latest group message
  const lastGroupMsg = await db.message.findFirst({
    where: { conversationId: group.id },
    orderBy: { createdAt: 'desc' }
  });
  if (lastGroupMsg) {
    for (const [userKey, emoji] of [
      ['alex', '🔥'],
      ['sarah', '❤️'],
      ['daniel', '👍']
    ] as [keyof typeof users, string][]) {
      await db.messageReaction.create({
        data: { messageId: lastGroupMsg.id, userId: users[userKey]!.id, emoji }
      });
    }
  }

  // ── Status / stories ──
  await db.status.create({
    data: {
      userId: users.sophia!.id,
      type: 'TEXT',
      content: 'Sunset walks hit different 🌅',
      background: 'linear-gradient(135deg, #FF6B5E 0%, #F5A623 100%)',
      expiresAt: new Date(now + 20 * 3600_000)
    }
  });
  await db.status.create({
    data: {
      userId: users.sarah!.id,
      type: 'TEXT',
      content: 'New week, new energy ✨',
      background: 'linear-gradient(135deg, #6D5EF5 0%, #22B8FF 100%)',
      expiresAt: new Date(now + 18 * 3600_000)
    }
  });
  await db.status.create({
    data: {
      userId: alex.id,
      type: 'TEXT',
      content: 'Chat. Share. Link up. 🚀',
      background: 'linear-gradient(135deg, #22C77D 0%, #22B8FF 100%)',
      expiresAt: new Date(now + 22 * 3600_000)
    }
  });

  // ── Notifications ──
  await db.notification.createMany({
    data: [
      {
        userId: alex.id,
        type: 'MESSAGE',
        title: 'Sophia Diallo',
        body: 'Are you coming to Jay’s set on Friday?',
        data: JSON.stringify({ conversationId: '' })
      },
      {
        userId: alex.id,
        type: 'GROUP_ADD',
        title: 'Weekend Crew 🎉',
        body: 'Sarah added you to the group',
        data: JSON.stringify({ conversationId: group.id })
      }
    ]
  });

  console.log('✅ Seed complete.');
  console.log('   Login with any demo username (e.g. "alex") and password "linkup123"');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
