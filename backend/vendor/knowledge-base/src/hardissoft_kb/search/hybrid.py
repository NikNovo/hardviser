"""Pinned-release retrieval with bounded authorization and safe operation-bound citations."""
import re
import secrets
from . import lexical, structured
from .context import validate_context
from .. import catalog

_OPERATIONS = {'explain', 'rfq', 'quote_compare'}
_MAX_CANDIDATES = 500
_RELATION_KINDS = {'requires_context', 'reply_to', 'post_reference', 'attached_to',
                   'derived_from', 'caption_of', 'translation_of', 'native_order',
                   'same_source_passage'}
_POLICY_REVISION = re.compile(r'^(?:0|[1-9][0-9]*)$')
_CITATION_ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def reciprocal_rank_fusion(rankings, k=60):
    scores = {}
    for ranking in rankings:
        seen = set()
        for rank, chunk_id in enumerate(ranking, 1):
            if chunk_id in seen:
                continue
            seen.add(chunk_id)
            scores[chunk_id] = scores.get(chunk_id, 0) + 1 / (k + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


def _select_vector_representatives(query, selected, ranked, by_id, vector_ids):
    """Prefer existing vector rank within fixed groups, preserving primary query IDs."""
    vector_ranks = {}
    for rank, chunk_id in enumerate(vector_ids):
        vector_ranks.setdefault(chunk_id, rank)
    winners = {row['evidence_source_group_id']: None for _, _, row in selected}
    for chunk_id, score in ranked:
        rank = vector_ranks.get(chunk_id)
        if rank is None:
            continue
        row = by_id.get(chunk_id)
        if row is None or row['content_role'] in ('source_catalog', 'process_record', 'generated_draft'):
            continue
        group = row['evidence_source_group_id']
        if group not in winners:
            continue
        previous = winners[group]
        # Strict improvement retains fused order when vector ranks are equal.
        if previous is None or rank < vector_ranks[previous[0]]:
            winners[group] = (chunk_id, score, row)
    query_ids = set(lexical.technical_ids(query))
    result = []
    for original in selected:
        winner = winners[original[2]['evidence_source_group_id']]
        if winner is None or winner[0] == original[0]:
            result.append(original)
            continue
        protected = query_ids.intersection(lexical.technical_ids(original[2]['retrieval_text']))
        if protected and not protected.issubset(lexical.technical_ids(winner[2]['retrieval_text'])):
            winner = original
        result.append(winner)
    return result


def citation_view(row, operation):
    """Public projection: no source IDs, hashes, private provenance, or internal groups."""
    view = {
        'text': row['retrieval_text'],
        'safe_locator': row['safe_locator'],
        'modality': row['modality'],
        'language': row['language'],
        'limitations': row['limitations'],
        'operation': operation,
        'content_role': row['content_role'],
    }
    reviewed_cells = []
    for cell in row.get('structured_cells', []):
        if cell.get('semantic_review_state') not in ('accepted', 'independently_reviewed', 'reviewed_safe'):
            continue
        reviewed_cells.append({key: cell[key] for key in (
            'raw_value', 'parsed_value', 'parse_state', 'header_path', 'unit', 'currency',
            'quantity_break', 'cell_type', 'locator') if key in cell})
    if reviewed_cells:
        view['structured_cells'] = reviewed_cells
    return view


def _citation(conn, row, context, *, context_relation=None):
    citation_id = 'cite_' + secrets.token_urlsafe(24)
    conn.execute('''INSERT INTO kb.citations(
      citation_id,release_id,chunk_id,grant_fingerprint,purpose,operation,context_relation)
      VALUES(%s,%s,%s,%s,%s,%s,%s)''', (
        citation_id, context['release_id'], row['chunk_id'], context['grant_fingerprint'],
        context['purpose'], context.get('operation', 'explain'), context_relation))
    return citation_id


def _validate_request(request):
    if not isinstance(request, dict):
        raise ValueError('search request object required')
    if set(request) - {'query', 'top_k', 'operation', 'languages', 'modalities', 'include_neighbors', 'mode'}:
        raise ValueError('unsupported request fields; grants cannot be supplied')
    query = request.get('query', '')
    if not isinstance(query, str) or not query.strip() or len(query) > 8192:
        raise ValueError('bounded query required')
    top = request.get('top_k', 10)
    if isinstance(top, bool) or not isinstance(top, int) or not 1 <= top <= 50:
        raise ValueError('top_k must be 1..50')
    operation = request.get('operation', 'explain')
    if operation not in _OPERATIONS:
        raise ValueError('unsupported operation')
    mode = request.get('mode', 'hybrid')
    if mode not in ('hybrid', 'lexical'):
        raise ValueError('unsupported retrieval mode')
    for key in ('languages', 'modalities'):
        if key in request and (not isinstance(request[key], list) or not all(isinstance(value, str) for value in request[key])):
            raise ValueError(key + ' must be list')
    if 'include_neighbors' in request and type(request['include_neighbors']) is not bool:
        raise ValueError('include_neighbors must be boolean')
    return query, top, operation, mode


def _search(request, trusted_context, *, include_candidate_refs):
    context = validate_context(trusted_context)
    query, top, operation, mode = _validate_request(request)
    context['operation'] = operation
    vector_module = None
    prepared_query = None
    if mode == 'hybrid':
        # Query encoding stays outside the shared current-policy transaction/lock.
        from . import vector as vector_module
        prepared_query = vector_module.prepare_query(query)
        if not isinstance(prepared_query, dict):
            raise RuntimeError('vector query preparation failed closed')
    with catalog.connect() as conn:
        # Candidate SQL performs release, role, scope, and current-policy filtering before ranking.
        candidates, context, info = catalog.authorized_candidates(context, conn=conn, request=request)
        rank_limit = min(_MAX_CANDIDATES, max(100, top * 8))
        lexical_ids = lexical.rank(conn, query, candidates, top_k=rank_limit)
        structured_ids = structured.rank(conn, query, candidates, top_k=rank_limit)
        rankings = [lexical_ids, structured_ids]
        reasons = {}
        for name, ranking in (('lexical', lexical_ids), ('structured', structured_ids)):
            for chunk_id in ranking:
                reasons.setdefault(chunk_id, []).append(name)
        retrieval_mode = 'lexical_only'
        if mode == 'hybrid':
            vector_spec = info['index_spec'].get('vector')
            if not isinstance(vector_spec, dict) or not vector_spec.get('config_hash'):
                raise PermissionError('accepted vector index is unavailable')
            if prepared_query.get('config_hash') != vector_spec['config_hash']:
                raise PermissionError('prepared query does not match accepted vector specification')
            vectors = vector_module.search(
                query, candidates, info['release_id'], top_k=rank_limit,
                expected_config_hash=vector_spec['config_hash'], prepared_query=prepared_query)
            vector_ids = [item['chunk_id'] if isinstance(item, dict) else item for item in vectors]
            rankings.append(vector_ids)
            for chunk_id in vector_ids:
                reasons.setdefault(chunk_id, []).append('vector')
            retrieval_mode = 'hybrid'
        ranked = reciprocal_rank_fusion(rankings)
        candidate_ids = [chunk_id for chunk_id, _ in ranked[:rank_limit]]
        # Recheck live policy and hydrate only the bounded fused result set.
        rows = candidates.fetch_rows(conn, candidate_ids)
        by_id = {row['chunk_id']: row for row in rows}
        groups = set()
        selected = []
        for chunk_id, score in ranked:
            row = by_id.get(chunk_id)
            if row is None or row['content_role'] in ('source_catalog', 'process_record', 'generated_draft'):
                continue
            group = row['evidence_source_group_id']
            if group in groups:
                continue
            groups.add(group)
            selected.append((chunk_id, score, row))
            if len(selected) >= top:
                break
        if mode == 'hybrid':
            selected = _select_vector_representatives(query, selected, ranked, by_id, vector_ids)
        neighbor_map = {}
        neighbor_rows = {}
        if request.get('include_neighbors') and selected:
            neighbor_map = structured.neighbors(conn, candidates,
                                                [item[0] for item in selected], limit=4)
            all_neighbor_ids = list(dict.fromkeys(
                entry['chunk_id'] for entries in neighbor_map.values() for entry in entries))
            if all_neighbor_ids:
                hydrated = candidates.fetch_rows(conn, all_neighbor_ids)
                neighbor_rows = {row['chunk_id']: row for row in hydrated}
        structural_neighbor_ids = {
            entry['chunk_id']
            for entries in neighbor_map.values()
            for entry in entries
        }
        support_by_primary = {}
        if mode == 'hybrid' and request.get('include_neighbors') and selected:
            primary_ids = {item[0] for item in selected}
            for primary_id, _, primary in selected:
                for support_id, _ in ranked:
                    support = by_id.get(support_id)
                    if (support is None or support_id in primary_ids or
                            support_id in structural_neighbor_ids or
                            support['content_role'] in ('source_catalog', 'process_record', 'generated_draft') or
                            support['evidence_source_group_id'] != primary['evidence_source_group_id'] or
                            support['source_version_id'] != primary['source_version_id']):
                        continue
                    support_by_primary[primary_id] = support
                    break
        candidate_set_id = 'cs_' + secrets.token_urlsafe(24) if include_candidate_refs else None
        policy_revision = str(context['policy_revision'])
        request_binding = catalog.digest({
            'request': request,
            'principal_id': context['principal_id'],
            'scope': context['scope'],
            'allowed_collections': context['allowed_collections'],
            'purpose': context['purpose'],
            'grant_fingerprint': context['grant_fingerprint'],
            'operator': context.get('operator') is True,
            'allow_machine_screened': context.get('allow_machine_screened') is True,
            'release_id': info['release_id'],
            'policy_revision': policy_revision,
        }) if include_candidate_refs else None
        results = []
        candidate_refs = []
        filters = {key: request[key] for key in ('languages', 'modalities') if request.get(key)}
        for chunk_id, score, row in selected:
            view = citation_view(row, operation)
            citation_id = _citation(conn, row, context)
            view.update(citation_id=citation_id, reasons=reasons.get(chunk_id, []), rrf_score=score)
            private_ref = None
            if include_candidate_refs:
                private_ref = {
                    'candidate_set_id': candidate_set_id,
                    'request_binding': request_binding,
                    'policy_revision': policy_revision,
                    'citation_id': citation_id, 'chunk_id': chunk_id,
                    'evidence_source_group_id': row['evidence_source_group_id'],
                    'release_id': info['release_id'], 'grant_fingerprint': context['grant_fingerprint'],
                    'purpose': context['purpose'], 'operation': operation,
                    'request_filters': {key: list(value) for key, value in filters.items()},
                    'neighbors': [],
                }
            if request.get('include_neighbors'):
                view['neighbors'] = []
                for entry in neighbor_map.get(chunk_id, []):
                    neighbor = neighbor_rows.get(entry['chunk_id'])
                    if neighbor is None:
                        continue
                    relation_kind = entry['relation_kind']
                    required_context = relation_kind == 'requires_context'
                    neighbor_citation_id = _citation(conn, neighbor, context, context_relation=relation_kind)
                    item = citation_view(neighbor, operation)
                    item.update(citation_id=neighbor_citation_id,
                                context_relation=relation_kind,
                                required_context=required_context)
                    view['neighbors'].append(item)
                    if private_ref is not None:
                        private_ref['neighbors'].append({
                            'candidate_set_id': candidate_set_id,
                            'request_binding': request_binding,
                            'policy_revision': policy_revision,
                            'citation_id': neighbor_citation_id,
                            'chunk_id': neighbor['chunk_id'],
                            'evidence_source_group_id': neighbor['evidence_source_group_id'],
                            'release_id': info['release_id'],
                            'grant_fingerprint': context['grant_fingerprint'],
                            'purpose': context['purpose'], 'operation': operation,
                            'context_relation': relation_kind, 'required_context': required_context,
                        })
                support = support_by_primary.get(chunk_id)
                if support is not None and len(view['neighbors']) < 4:
                    relation_kind = 'same_source_passage'
                    neighbor_citation_id = _citation(conn, support, context, context_relation=relation_kind)
                    item = citation_view(support, operation)
                    item.update(citation_id=neighbor_citation_id,
                                context_relation=relation_kind,
                                required_context=False)
                    view['neighbors'].append(item)
                    if private_ref is not None:
                        private_ref['neighbors'].append({
                            'candidate_set_id': candidate_set_id,
                            'request_binding': request_binding,
                            'policy_revision': policy_revision,
                            'citation_id': neighbor_citation_id,
                            'chunk_id': support['chunk_id'],
                            'evidence_source_group_id': support['evidence_source_group_id'],
                            'release_id': info['release_id'],
                            'grant_fingerprint': context['grant_fingerprint'],
                            'purpose': context['purpose'], 'operation': operation,
                            'context_relation': relation_kind, 'required_context': False,
                        })
            results.append(view)
            if private_ref is not None:
                candidate_refs.append(private_ref)
        public_result = {
            'results': results,
            'limitations': [],
            'retrieval_mode': retrieval_mode,
            'release_id': info['release_id'],
            'policy_revision': str(context['policy_revision']),
            'trace_id': 'trace_' + secrets.token_hex(16),
        }
        return public_result, candidate_refs


def search(request, context):
    """Public search API. Internal row identities are always discarded."""
    return _search(request, context, include_candidate_refs=False)[0]


def search_internal(request, trusted_context):
    """Backend-only paired search references under internal retrieval authorization."""
    context = validate_context(trusted_context)
    if context.get('operator') is not True or context.get('purpose') != 'internal_retrieval':
        raise PermissionError('server-created internal retrieval context required')
    public_result, candidate_refs = _search(request, context, include_candidate_refs=True)
    return {'public_result': public_result, 'candidate_refs': candidate_refs}


def _internal_refs(candidate_refs):
    """Validate the exact private reference leaves emitted by search_internal."""
    if not isinstance(candidate_refs, (list, tuple)):
        raise ValueError('candidate refs must be an ordered list')
    parents=[]; flattened=[]; seen=set(); signatures=set()
    parent_fields={'candidate_set_id','request_binding','policy_revision','citation_id','chunk_id',
                   'evidence_source_group_id','release_id','grant_fingerprint','purpose','operation',
                   'request_filters','neighbors'}
    neighbor_fields={'candidate_set_id','request_binding','policy_revision','citation_id','chunk_id',
                     'evidence_source_group_id','release_id','grant_fingerprint','purpose','operation',
                     'context_relation','required_context'}
    identity_fields=('candidate_set_id','request_binding','policy_revision','release_id',
                     'grant_fingerprint','purpose','operation')
    for parent in candidate_refs:
        if not isinstance(parent,dict) or set(parent)!=parent_fields or not isinstance(parent['neighbors'],list):
            raise ValueError('invalid candidate reference')
        filters=parent['request_filters']
        if any(not isinstance(parent.get(key),str) or not parent[key] for key in identity_fields):
            raise ValueError('candidate set identity fields are invalid')
        if (not isinstance(filters,dict) or set(filters)-{'languages','modalities'} or
                any(not isinstance(values,list) or not all(isinstance(value,str) for value in values)
                    for values in filters.values())):
            raise ValueError('invalid candidate search filters')
        filter_signature=tuple(sorted((key,tuple(values)) for key,values in filters.items()))
        signature=tuple(parent[key] for key in identity_fields)+(filter_signature,)
        signatures.add(signature)
        parents.append(parent)
        if len(parent['neighbors'])>4:
            raise ValueError('candidate neighbor limit exceeded')
        same_source_count = 0
        for index,ref in enumerate([parent,*parent['neighbors']]):
            expected=parent_fields if index==0 else neighbor_fields
            if not isinstance(ref,dict) or set(ref)!=expected:
                raise ValueError('candidate reference fields incomplete')
            for key in ('candidate_set_id','chunk_id','evidence_source_group_id','release_id',
                        'grant_fingerprint','purpose','operation'):
                if not isinstance(ref[key],str) or not ref[key]:
                    raise ValueError('invalid candidate reference value')
            if (not isinstance(ref['citation_id'],str) or not _CITATION_ID.fullmatch(ref['citation_id']) or
                    not isinstance(ref['request_binding'],str) or not catalog._HASH.fullmatch(ref['request_binding']) or
                    not isinstance(ref['policy_revision'],str) or not _POLICY_REVISION.fullmatch(ref['policy_revision'])):
                raise ValueError('invalid CandidateSet identity binding')
            if ref['purpose']!='internal_retrieval' or ref['operation'] not in _OPERATIONS:
                raise ValueError('candidate ref is not an internal search result')
            if index:
                if (not isinstance(ref['context_relation'],str) or ref['context_relation'] not in _RELATION_KINDS or
                        type(ref['required_context']) is not bool):
                    raise ValueError('candidate neighbor context is invalid')
                if ref['context_relation'] == 'same_source_passage':
                    if ref['required_context'] is not False:
                        raise ValueError('same-source support cannot be required context')
                    same_source_count += 1
                    if same_source_count > 1:
                        raise ValueError('candidate ref includes multiple same-source supports')
                if any(ref[key]!=parent[key] for key in identity_fields):
                    raise ValueError('candidate neighbor binding mismatch')
            if ref['citation_id'] in seen:
                raise ValueError('duplicate candidate citation reference')
            seen.add(ref['citation_id']); flattened.append(ref)
        if len(flattened)>_MAX_CANDIDATES:
            raise ValueError('candidate reference set exceeds bound')
    if len(signatures)>1:
        raise ValueError('candidate refs mix search contexts')
    return parents,flattened




def _citation_group(citation, context):
    if citation['grant_fingerprint'] != context['grant_fingerprint'] or citation['purpose'] != context['purpose']:
        raise PermissionError('citation grant mismatch')
    if context.get('release_id') and context['release_id'] != citation['release_id']:
        raise PermissionError('citation release mismatch')
    operation = citation.get('operation') or 'explain'
    if operation not in _OPERATIONS or (context.get('operation') and context['operation'] != operation):
        raise PermissionError('citation operation mismatch')
    return citation['release_id'], operation


def _resolve_citation_group(conn, citations, context, release_id, operation):
    scoped = dict(context, release_id=release_id, operation=operation)
    rows, current, info = catalog.authorized_rows(
        scoped, conn=conn, chunk_ids=[citation['chunk_id'] for _, citation in citations],
        destination=context['purpose'], request={'operation': operation})
    by_chunk = {row['chunk_id']: row for row in rows}
    results = {}
    for citation_id, citation in citations:
        try:
            row = by_chunk.get(citation['chunk_id'])
            if row is None:
                raise PermissionError('citation revoked or unavailable')
            results[citation_id] = {
                'citation_id': citation_id, 'release_id': info['release_id'],
                'policy_revision': str(current['policy_revision']), **citation_view(row, operation)}
        except Exception as error:
            results[citation_id] = error
    return results


def resolve_citation(citation_id, context):
    """Public citation projection with no private row identities or integrity hashes."""
    context = validate_context(context)
    with catalog.connect() as conn:
        citation = conn.execute('SELECT * FROM kb.citations WHERE citation_id=%s', (citation_id,)).fetchone()
        if not citation:
            raise LookupError('citation unavailable')
        release_id, operation = _citation_group(citation, context)
        result = _resolve_citation_group(
            conn, [(citation_id, citation)], context, release_id, operation)[citation_id]
        if isinstance(result, Exception):
            raise result
        return result


def resolve_citations(citation_ids, context):
    """Resolve bounded citations under one connection and one authorization per group."""
    context = validate_context(context)
    if (not isinstance(citation_ids, (list, tuple)) or
            any(not isinstance(value, str) or not value for value in citation_ids)):
        raise ValueError('bounded citation id list required')
    if len(citation_ids) > _MAX_CANDIDATES:
        raise ValueError('citation resolution exceeds bounded candidate count')
    requested = list(dict.fromkeys(citation_ids))
    if not requested:
        return {}

    results = {}
    groups = {}
    with catalog.connect() as conn:
        rows = conn.execute(
            'SELECT * FROM kb.citations WHERE citation_id=ANY(%s::text[])', (requested,)).fetchall()
        by_id = {row['citation_id']: row for row in rows}
        for citation_id in requested:
            citation = by_id.get(citation_id)
            if citation is None:
                results[citation_id] = LookupError('citation unavailable')
                continue
            try:
                release_id, operation = _citation_group(citation, context)
            except Exception as error:
                results[citation_id] = error
                continue
            groups.setdefault((release_id, operation), []).append((citation_id, citation))
        for (release_id, operation), citations in groups.items():
            try:
                results.update(_resolve_citation_group(
                    conn, citations, context, release_id, operation))
            except Exception as error:
                for citation_id, _ in citations:
                    results[citation_id] = error

    return {citation_id: (result if not isinstance(result, Exception)
                          else {'_error': type(result).__name__})
            for citation_id, result in results.items()}
