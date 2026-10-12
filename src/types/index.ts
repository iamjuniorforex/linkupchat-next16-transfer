// Shared client/server DTOs for LINKUPCHAT.

export type Role = 'USER' | 'MODERATOR' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED';
export type ConversationType = 'DIRECT' | 'GROUP';
export type MemberRole = 'MEMBER' | 'ADMIN';
export type MessageType =
  | 'TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'AUDIO'
  | 'VOICE'
  | 'DOCUMENT'
  | 'GIF'
  | 'STICKER'
  | 'SYSTEM';
export type PrivacyLevel = 'EVERYONE' | 'CONTACTS' | 'NOBODY';
export type Theme = 'LIGHT' | 'DARK' | 'SYSTEM';
export type CallType = 'VOICE' | 'VIDEO';
export type CallStatus =
  | 'RINGING'
  | 'CONNECTED'
  | 'ENDED'
  | 'MISSED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'FAILED';

export interface UserDTO {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  coverUrl?: string | null;
  accentColor?: string | null;
  about: string;
  isOnline: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  emailVerified: boolean;
  role?: Role;
  status?: UserStatus;
  email?: string | null;
  phone?: string | null;
  isContact?: boolean;
  isBlocked?: boolean;
  badge?: 'premium' | 'business' | null;
  businessVerified?: boolean;
  businessName?: string | null;
  businessWebsite?: string | null;
}

export interface MeDTO extends UserDTO {
  email: string | null;
  phone: string | null;
  role: Role;
  status: UserStatus;
  settings: UserSettingsDTO;
}

export interface UserSettingsDTO {
  theme: Theme;
  enterToSend: boolean;
  mediaAutoDownload: boolean;
  wallpaper: string;
  notifMessages: boolean;
  notifGroups: boolean;
  notifCalls: boolean;
  notifSounds: boolean;
  notifPreview: boolean;
  notifEnabled: boolean;
  notifStatus: boolean;
  privacyLastSeen: PrivacyLevel;
  privacyOnline: PrivacyLevel;
  privacyProfilePhoto: PrivacyLevel;
  privacyAbout: PrivacyLevel;
  privacyStatus: PrivacyLevel;
  privacyReadReceipts: boolean;
  privacyPhoneSearch: PrivacyLevel;
  privacyAddMe: PrivacyLevel;
  privacyMessage: PrivacyLevel;
  privacyDiscover: PrivacyLevel;
}

export interface AttachmentDTO {
  id: string;
  kind: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fileName: string | null;
}

export interface ReactionDTO {
  emoji: string;
  count: number;
  userIds: string[];
  reacted: boolean;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  senderId: string | null;
  sender?: Pick<UserDTO, 'id' | 'username' | 'displayName' | 'avatarUrl'> | null;
  type: MessageType;
  content: string | null;
  clientNonce?: string | null;
  replyToId: string | null;
  replyTo?: {
    id: string;
    content: string | null;
    type: MessageType;
    senderName: string | null;
    senderId: string | null;
    deletedAt?: boolean;
  } | null;
  attachments: AttachmentDTO[];
  reactions: ReactionDTO[];
  editedAt: string | null;
  deletedAt: string | null;
  pinnedAt: string | null;
  createdAt: string;
  /** Row-level update timestamp (edit/delete) — distinct from editedAt. */
  updatedAt: string;
  status?: 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  readBy?: string[];
  isMine?: boolean;
}

export interface ConversationMemberDTO {
  userId: string;
  role: MemberRole;
  joinedAt: string;
  /** Whether the viewing user may change this member's role/membership. */
  canManageMembers: boolean;
  user: Pick<UserDTO, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'isOnline' | 'lastSeenAt'>;
}

export interface ConversationDTO {
  id: string;
  type: ConversationType;
  title: string | null;
  description: string | null;
  avatarUrl: string | null;
  memberCount: number;
  members?: ConversationMemberDTO[];
  // DIRECT convenience fields
  peer?: Pick<UserDTO, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'isOnline' | 'lastSeenAt' | 'about'> | null;
  lastMessage: MessageDTO | null;
  unreadCount: number;
  isMuted: boolean;
  isPinned: boolean;
  isArchived: boolean;
  lastReadMessageId: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  onlyAdminsMessage?: boolean;
  onlyAdminsEditInfo?: boolean;
  onlyAdminsAddMembers?: boolean;
  myRole?: MemberRole;
}

export interface StatusDTO {
  id: string;
  userId: string;
  user?: Pick<UserDTO, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  type: 'TEXT' | 'IMAGE' | 'VIDEO';
  content: string | null;
  background: string | null;
  mediaUrl: string | null;
  mediaThumb: string | null;
  createdAt: string;
  expiresAt: string;
  viewerCount?: number;
  viewedByMe?: boolean;
  viewed?: boolean;
  fontStyle?: string | null;
  textColor?: string | null;
  audience?: 'CONTACTS' | 'CONTACTS_EXCEPT' | 'ONLY_SHARE';
  myReaction?: string | null;
  reactionCount?: number;
  archivedAt?: string | null;
}

export interface CallRecordDTO {
  id: string;
  type: CallType;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  direction: 'OUTGOING' | 'INCOMING';
  peer: Pick<UserDTO, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  conversationId: string | null;
  /** Group mesh call. Absent or false for existing 1:1 history rows. */
  isGroup?: boolean;
  participantCount?: number;
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface ContactDTO {
  id: string;
  nickname: string | null;
  createdAt: string;
  user: Pick<UserDTO, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'about' | 'isOnline' | 'lastSeenAt'>;
}
