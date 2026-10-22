// Uploaded files belong to the uploader's group: UECS users and regular users each see only
// their own group's files, while administrators see every file.
export const UECS_GROUP = 'uecs';
export const GENERAL_GROUP = 'general';

export const fileGroupOf = (session) => (session?.role === 'uecs' ? UECS_GROUP : GENERAL_GROUP);

export const visibleFiles = (session, alias) => (session?.isAdmin === true
  ? { where: 'TRUE', values: [] }
  : { where: `${alias}.owner_group = ?`, values: [fileGroupOf(session)] });
