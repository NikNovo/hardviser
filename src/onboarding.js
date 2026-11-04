// Server brief fields share their keys with the local project brief.
const SERVER_BRIEF_KEYS = ['description', 'audience', 'markets', 'team', 'goal', 'notes'];

const hasText = value => typeof value === 'string' && value.trim().length > 0;

export function projectDetailsFromServerProject(serverProject) {
  const fields = serverProject?.brief_fields && typeof serverProject.brief_fields === 'object' ? serverProject.brief_fields : {};
  const details = Object.fromEntries(SERVER_BRIEF_KEYS.filter(key => hasText(fields[key])).map(key => [key, fields[key]]));
  if (!Object.keys(details).length && hasText(serverProject?.brief_text)) details.notes = serverProject.brief_text;
  return details;
}

export function unlinkedServerProjects(localProjects, serverProjects) {
  const linked = new Set(localProjects.map(project => project.serverProjectId).filter(Boolean));
  return serverProjects.filter(project => !linked.has(project.id));
}
