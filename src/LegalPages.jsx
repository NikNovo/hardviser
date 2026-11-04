import { useState } from 'react';
import { Download, FileSignature } from 'lucide-react';
import { downloadText } from './storage.js';
import SectionHeader from './SectionHeader.jsx';

const PAGES = {
  'code-of-conduct': { title: 'Code of Conduct', lead: 'Practical standards for working with founders, experts and suppliers.', sections: [
    ['Respect people and their work', 'Be professional and specific. Do not harass, discriminate, threaten or misrepresent another person’s work. Critique evidence and decisions, not personal characteristics.'],
    ['Make claims traceable', 'Distinguish a hypothesis, a measured result and a third-party claim. Link the evidence behind reviews, certifications, supplier checks and performance figures. Disclose conflicts of interest and paid recommendations.'],
    ['Share only what you may share', 'Get permission before sharing confidential designs, personal data or another party’s materials. An NDA draft in this workspace is not a signed agreement. Limit access to what a task actually needs.'],
    ['Build responsibly', 'Use qualified review for electrical, mechanical, battery, medical and other safety-critical work. Do not treat an AI answer or a manually assigned status as proof of safety or regulatory compliance.'],
    ['Keep commercial arrangements explicit', 'Agree on scope, price, milestones, acceptance criteria, confidentiality and ownership before work begins. Do not claim that a draft request has been ordered, paid or approved.'],
    ['If something goes wrong', 'Stop sharing the affected material, preserve the relevant records, and contact the parties through an independently verified channel. This local test has no community moderation or dispute-resolution service.'],
  ] },
  terms: { title: 'Test workspace terms', lead: 'Scope and limitations of this interactive preview — not an executed customer agreement.', sections: [
    ['What this version does', 'hardviser.com combines a browser-local project workspace with an authenticated server-backed AI Cofounder. Dashboard access uses your server account. Local profile, records and readiness data are separated by account in this browser; server projects, chats, tasks, briefs and files also belong to your signed-in account. Local data does not synchronize between devices. There is no paid supplier ordering or electronic signing.'],
    ['Your responsibility', 'Upload only materials you are entitled to use and share. Keep independent backups. You are responsible for checking project assumptions, engineering decisions and the identity, qualifications and terms of outside providers.'],
    ['AI is assistance, not authority', 'AI may be incomplete or incorrect. It is not a legal cofounder, engineer of record, patent attorney or certification body. Replies require an enabled provider account. A prepared brief is not a submitted order or a completed expert review.'],
    ['External services', 'Links may open services operated by other organizations. Their access, pricing and terms are separate. HardIsSoft does not confirm availability, endorsement or a commercial relationship merely by displaying a link.'],
    ['No production service commitment', 'This public test does not promise uptime, cloud recovery, confidentiality guarantees, regulated storage or support response times. Do not rely on it as the sole record of a safety-critical or commercially sensitive project.'],
    ['Before commercial use', 'The operator’s legal identity, jurisdiction, service terms, processor agreements and security arrangements must be agreed separately. This page does not invent those details or create a signed contract.'],
  ] },
  privacy: { title: 'Privacy & data handling', lead: 'Know what is stored locally and what is processed when you sign in or send an AI message.', sections: [
    ['Stored in this browser', 'Your profile name, role and organization, project selection, project fields, records, readiness answers, drafts and conversation histories are stored in localStorage under your authenticated account UUID. Uploaded local file originals use account-scoped keys in IndexedDB. Sidebar and appearance preferences remain browser settings. These stores are not encrypted; people with access to this browser profile may still read them. Older unassigned browser data is preserved for explicit recovery, not automatically loaded into an account.'],
    ['When you send a cofounder message', 'Your question, chat identifier, selected file identifiers and route choice go through the Vercel API to the authenticated Severus service. The service retrieves conversation history and project context and may send matching excerpts to Meta MUSE Standard. Technical questions also search the knowledge base.'],
    ['What is included in context', 'The selected server project brief is included. File excerpts come from mentioned files, otherwise pinned files, otherwise ready project files. Browser-local projects are not automatically imported. Context can contain confidential information; do not enter secrets or upload confidential material.'],
    ['Hosting and provider processing', 'Vercel hosts this test and handles network requests and associated technical metadata. AI providers apply their own processing and retention policies. This preview does not establish a zero-retention agreement or verify provider confidentiality settings. No product analytics or advertising SDK is installed in the application.'],
    ['Dashboard account and server storage', 'Sign-in uses an individual server account; sessionStorage holds the session token and selected server project and chat IDs. Sign out revokes the session and returns the dashboard to sign-in. Projects, chats, messages, tasks, briefs, uploaded files and file metadata are stored on the operator’s Severus server and scoped to that account. Browser-local projects remain local unless explicitly imported; import sends the project name and a bounded brief. Answers persist on the server and are not independently verified. New uploads support document, office, schematic, PCB, CAD, drawing and image formats up to 10 MiB per file, subject to account storage and file-count limits. Existing larger stored files remain selectable. Extraction may provide full text, a bounded summary or metadata only; the interface identifies that level. Processing failures remain visible, but their blobs are removed and excluded from storage quota. Operational logs omit login names, question text, file names and content, credentials and session tokens. Vercel, Severus and Meta process data under their own terms; zero retention and confidentiality are not guaranteed.'],
    ['Email sign-in', 'Email sign-in uses a verified email address as the account login. Verified email addresses are stored on the operator’s Severus server. A sign-in link expires after 15 minutes and creates a session only after you choose Continue. Cloudflare Turnstile verifies email sign-in requests and processes challenge data under its own terms. Resend processes the recipient address, message content and delivery data to send sign-in links under its own terms.'],
    ['Export and deletion', 'Workspace data settings export the current account’s local project or local workspace, including its local profile; those exports do not include server-side RAG projects, chats, messages, or file bytes. Original local files must be downloaded separately. Previous unassigned browser data and its original attachments have separate recovery-download controls. Use the RAG chat controls to delete an individual chat or server file. Clearing browser storage deletes local data for all accounts in that browser, not server-side chat records or data already processed by an external provider.'],
    ['Sharing and security boundaries', 'Switching accounts switches the active browser-local workspace as well as server identity. Local account separation is not encryption or protection against someone who can inspect the browser’s storage; use separate browser profiles on shared devices. RAG chat server projects are scoped to the signed-in account and are not shared with other accounts; anyone with access to the account or its signed-in browser session may access that account’s data. RAG chat can be opened from another signed-in browser, but it has no team roles or collaboration controls. Protect passwords and signed-in devices.'],
  ] },
  ip: { title: 'Intellectual property & ownership', lead: 'Record who owns what before handing designs to collaborators or suppliers.', sections: [
    ['The workspace is not an assignment', 'Saving a file, generating a brief, selecting an ownership status or chatting with AI does not transfer intellectual property rights or grant a patent. Keep executed agreements and legal advice as separate source records.'],
    ['Separate background and project IP', 'Identify pre-existing code, reference designs, libraries, patents and know-how. Record their owners, licenses and restrictions separately from new deliverables created for the project. Check rights to modify, manufacture, distribute and sublicense.'],
    ['Agree deliverables with contributors', 'Define source CAD, schematics, PCB layout, firmware, build files, manufacturing data, credentials and documentation. Identify who must deliver them, how they are accepted, and which rights are assigned or licensed in the signed agreement.'],
    ['Own the tooling arrangements', 'For molds, jigs and test fixtures, record title, physical location, access, maintenance, allowed users, reproduction rights and retrieval terms. Payment alone may not resolve ownership or the right to move tooling.'],
    ['Protect disclosure and patent options', 'Use an appropriate signed confidentiality agreement before sharing sensitive information. Public disclosure can affect patent rights differently by jurisdiction. Patentability, ownership and freedom to operate are different questions; get qualified jurisdiction-specific advice.'],
    ['Keep an evidence trail', 'Link signed agreements, versions, handover records and supplier acknowledgements in Contracts & NDAs or Development protection. Mark disputed or unverified claims clearly. The workspace does not verify execution or enforce rights.'],
  ] },
};
const NDA_FIELDS = [
  ['partyA', 'First party — full legal name'], ['partyB', 'Second party — full legal name'],
  ['purpose', 'Permitted evaluation purpose'], ['law', 'Governing law and agreed forum'],
  ['date', 'Proposed effective date', 'date'], ['term', 'Disclosure period (months)', 'number'],
  ['survival', 'Confidentiality period after termination (months)', 'number'],
];
function ndaText(values) {
  return `# Mutual non-disclosure agreement — REVIEW DRAFT, NOT SIGNED

Prepared locally in HardIsSoft. This is a starting point for qualified legal review, not legal advice or evidence of execution. No party has accepted or signed this document through this workspace.

Parties: ${values.partyA.trim()} and ${values.partyB.trim()}.
Proposed effective date: ${values.date}.
Purpose: ${values.purpose.trim()}.

## 1. Confidential information
Each party may disclose non-public technical, commercial or business information for the Purpose, including designs, source files, software, test results, prototypes, manufacturing information and supplier or customer information. Information is confidential if marked as such or if a reasonable recipient would understand its confidential nature in the circumstances. The parties should confirm oral disclosures and any special handling requirements in writing.

## 2. Permitted use and care
The receiving party will use confidential information only for the Purpose, protect it with reasonable care and at least the care used for its own similar information, and not disclose it except to representatives who need to know it for the Purpose and are bound by obligations at least as protective. The receiving party remains responsible for those representatives. Copies will be limited to those reasonably necessary for the Purpose.

## 3. Exclusions
The obligations do not apply to information the receiving party can demonstrate was already lawfully known without restriction, becomes public without breach, is lawfully received from a third party without a duty of confidentiality, or is independently developed without using the disclosed information.

## 4. Legally required disclosure
If disclosure is legally required, the recipient will, where lawful, give prompt notice, reasonably assist requests for protective measures, and disclose only what is legally required. This does not authorize any other use or disclosure.

## 5. Rights and project outputs
Each party retains its existing rights. No patent, copyright, trade-secret or other intellectual property license is granted except the limited right to use the information for the Purpose. Ownership and licenses for new work, improvements, source files and tooling require a separate written agreement. Neither party is required to proceed with a transaction.

## 6. Return and deletion
On written request or termination, the recipient will stop using the information and return or destroy reasonably accessible copies, subject to legal retention duties and routine backup copies not readily accessible in the ordinary course. Any retained copies remain subject to confidentiality and use restrictions. The parties should agree a practical deletion confirmation procedure.

## 7. Duration
The proposed period for disclosures is ${values.term} months from the effective date, unless terminated earlier by written notice. Confidentiality and permitted-use obligations continue for ${values.survival} months after termination or expiry. Trade secrets remain protected for as long as they qualify for protection under applicable law. A qualified adviser must review these durations and the trade-secret provision for the relevant jurisdictions.

## 8. Incident notice and remedies
A party discovering unauthorized use or disclosure will promptly notify the other party and reasonably cooperate to limit its effects. Available remedies, liability limitations and any right to seek urgent court relief must be reviewed under the applicable law; this draft does not assume automatic entitlement to a particular remedy.

## 9. Governing law and forum
Proposed governing law and agreed forum: ${values.law.trim()}.
The parties must confirm the precision, suitability and enforceability of this choice before signing.

## 10. Execution and changes
This draft becomes an agreement only after review and execution by authorized representatives of both parties through an agreed signing process. Changes must be agreed in writing. Notices, legal addresses and authorized signatories must be confirmed before execution.

Execution status: NOT SIGNED. No signature has been captured, verified or applied by HardIsSoft.

First party: ${values.partyA.trim()}
Second party: ${values.partyB.trim()}
`;
}
function NDAPage() {
  const [values, setValues] = useState(Object.fromEntries(NDA_FIELDS.map(([key]) => [key, ''])));
  const [draft, setDraft] = useState('');
  return <div className="legal-page-layout">
    <SectionHeader section="Legal" title="NDA review draft" description="Prepare a mutual confidentiality draft for discussion with the other party and a qualified adviser."/>
    <div className="notice"><FileSignature size={18}/><span>Draft only. This does not sign an agreement, establish confidentiality with the platform or protect a disclosure already made.</span></div>
    <form className="panel" onSubmit={event => { event.preventDefault(); setDraft(ndaText(values)); }}>
      <h2>Define the parties and purpose</h2>
      <div className="form-grid">
        {NDA_FIELDS.map(([key, label, type = 'text', autocomplete]) => (
          <label className="field" key={key}>
            <span>{label} *</span>
            {key === 'purpose'
              ? <textarea name={key} autoComplete={autocomplete} required rows={3} value={values[key]} onChange={event => { setValues({ ...values, [key]: event.target.value }); setDraft(''); }}/>
              : <input name={key} autoComplete={autocomplete} type={type} required min={type === 'number' ? 1 : undefined} step={type === 'number' ? 1 : undefined} value={values[key]} onChange={event => { setValues({ ...values, [key]: event.target.value }); setDraft(''); }}/>}
          </label>
        ))}
      </div>
      <button type="submit" className="button primary">Prepare review draft</button>
    </form>
    <section className="panel">
      <h2>Before you share designs</h2>
      <ul>
        <li>Verify the parties’ legal identities and the authority of the people signing.</li>
        <li>Agree the purpose, permitted recipients, security measures, term and jurisdiction.</li>
        <li>Address reverse engineering, AI-provider disclosure and cross-border transfer explicitly when relevant.</li>
        <li>Keep IP assignment, deliverable ownership and tooling rights in the appropriate agreements.</li>
        <li>Get qualified review and a real signature before relying on confidentiality obligations.</li>
      </ul>
      <a href="#/protection/contracts" className="text-link">Keep the reviewed agreement in Contracts & NDAs</a>
    </section>
    {draft && <section className="panel">
      <div className="section-heading">
        <h2>Review draft · not signed</h2>
        <button className="button secondary" onClick={() => downloadText(draft, 'HardIsSoft-mutual-NDA-review-draft.md')}><Download size={15}/>Download draft</button>
      </div>
      <pre className="legal-draft">{draft}</pre>
    </section>}
  </div>;
}
export default function LegalPage({ page }) {
  if (page === 'nda') return <NDAPage/>;
  const content = Object.hasOwn(PAGES, page) ? PAGES[page] : null;
  if (!content) return <div className="legal-page-layout"><section className="panel"><h1>Page not found</h1><a href="#/overview">Return to workspace</a></section></div>;
  return <div className="legal-page-layout">
    <SectionHeader section="Legal" title={content.title} description={content.lead}/>
    <article className="panel legal-page">
      {content.sections.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}
    </article>
  </div>;
}
