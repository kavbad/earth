/**
 * Web-only microcopy for moments the spec leaves unnamed (field labels, hints, error lines).
 * Everything the spec does quote comes from `@earth/ui`'s `copy` and is never restated here.
 */
export const webCopy = {
  continue: 'Continue',
  back: 'Back',
  close: 'Close',
  loading: 'Loading',
  mainNavigation: 'Main',
  radiusLabel: 'Radius',
  signOut: 'Sign out',
  retry: 'Retry',

  // Claim gate (spec §44)
  inviteLinkLabel: 'Invite link or code',
  inviteLinkHint: 'Paste the link someone sent you.',
  inviteInvalid: "That invite link doesn't work anymore.",
  inviteExpired: 'This invite has expired.',
  continueWithoutGroup: 'Continue without a group',

  // Group label (spec §45 step 2)
  groupNameLabel: 'Group name',

  // Credential (spec §45 step 4)
  signInMethod: 'How to reach you',
  email: 'Email',
  phone: 'Phone',
  emailLabel: 'Email address',
  phoneLabel: 'Phone number',
  phoneHint: 'Include the country code, like +1 415 555 0100.',
  sendCode: 'Send code',
  codeLabel: 'Code',
  codeSent: (destination: string): string => `We sent a code to ${destination}.`,
  codeInvalid: "That code didn't work. Check it and try again.",
  checkAddress: "That doesn't look right. Check it and try again.",
  tooManyTries: 'Too many tries. Give it a minute.',
  sendAgain: 'Send again',
  useDifferent: 'Use a different email or phone',

  // Identity (spec §45 step 5)
  displayNameHint: 'How people on Earth will see you.',
  handleHint: 'Letters, numbers and underscores.',
  handleChecking: 'Checking…',
  handleAvailable: 'Available',
  handleTaken: 'That handle is taken.',
  handleInvalid: "That handle can't be used.",
  photoOptional: 'Optional',
  choosePhoto: 'Choose photo',
  changePhoto: 'Change photo',
  removePhoto: 'Remove photo',

  // Human Pass (spec §45 step 6, §111)
  startVerification: 'Start verification',
  openVerification: 'Open verification',
  verifying: 'Verifying…',
  finishingUp: 'Finishing up…',
  verificationTechnical: 'Something went wrong on our side. Nothing about you was decided.',
  verificationInconclusive: "We couldn't finish verifying automatically. A person can help.",
  helpRequested: 'Thanks. A person will review this and get back to you.',
  recoveryRequested: "We'll help you get back into your place.",
  safetyRequested: "We're on it. Someone from the safety team will follow up.",
  mockOutcomeLabel: 'Development: verification outcome',

  // Welcome (spec §49)
  enterYourGroup: 'Enter your group',
  backToEarth: 'Back to Earth',

  // Group invite (spec §46–§47)
  inviteMembers: (count: number): string => (count === 1 ? '1 member' : `${count} members`),
  inviteNotFound: "This link doesn't lead anywhere anymore.",
  alreadyMember: "You're already in this group.",
  openConversation: 'Open the conversation',

  // Failure states (spec PART XX)
  somethingWrong: "That didn't go through.",
  envMissing: 'Earth is not configured for this environment.',
} as const

export type WebCopy = typeof webCopy
