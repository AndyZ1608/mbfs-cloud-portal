import { Router } from 'express';
import { OSError } from '../openstack.js';
import { currentProjectId } from '../projectScope.js';
import { catalog, createLabel, createTag, deleteLabel, deleteTag, updateLabel, updateTag } from '../classifications.js';

const router = Router();
const project = (req) => currentProjectId(req.session.os);
const manager = (req, _res, next) => req.session.os.roles?.some((role) => ['member', 'admin'].includes(role))
  ? next() : next(new OSError(403, 'Cần role member hoặc admin để quản lý Labels/Tags.', 'permission_denied'));
const audit = (res, action, type, resource) => {
  res.locals.classificationAudit = { action, provider: 'cmp', resource_type: type,
    resource_id: resource.id, resource_name: resource.name };
};

router.get('/classifications/catalog', (req, res, next) => {
  try { res.json(catalog(project(req))); } catch (error) { next(error); }
});

router.get('/classifications/labels', (req, res, next) => {
  try { res.json({ labels: catalog(project(req)).labels }); } catch (error) { next(error); }
});

router.get('/classifications/tags', (req, res, next) => {
  try { res.json({ tags: catalog(project(req)).tags }); } catch (error) { next(error); }
});

router.post('/classifications/labels', manager, (req, res, next) => {
  try {
    const label = createLabel(project(req), req.session.os.user.name, req.body);
    audit(res, 'label.create', 'label', label);
    res.status(201).json({ label });
  } catch (error) { next(error); }
});

router.patch('/classifications/labels/:id', manager, (req, res, next) => {
  try {
    const result = updateLabel(project(req), req.params.id, req.body);
    audit(res, 'label.update', 'label', result.label);
    res.json(result);
  } catch (error) { next(error); }
});

router.delete('/classifications/labels/:id', manager, (req, res, next) => {
  try {
    const removed = deleteLabel(project(req), req.params.id, req.body?.confirm);
    audit(res, 'label.delete', 'label', { id: req.params.id, name: removed.name });
    res.json(removed);
  } catch (error) { next(error); }
});

router.post('/classifications/tags', manager, (req, res, next) => {
  try {
    const tag = createTag(project(req), req.session.os.user.name, req.body);
    audit(res, 'tag.create', 'tag', tag);
    res.status(201).json({ tag });
  } catch (error) { next(error); }
});

router.patch('/classifications/tags/:id', manager, (req, res, next) => {
  try {
    const tag = updateTag(project(req), req.params.id, req.body);
    audit(res, 'tag.update', 'tag', tag);
    res.json({ tag });
  } catch (error) { next(error); }
});

router.delete('/classifications/tags/:id', manager, (req, res, next) => {
  try {
    const removed = deleteTag(project(req), req.params.id, req.body?.confirm);
    audit(res, 'tag.delete', 'tag', { id: req.params.id, name: removed.name });
    res.json(removed);
  } catch (error) { next(error); }
});

export default router;
