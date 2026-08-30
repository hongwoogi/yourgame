import { handleApi } from '../server/app.mjs';
export default function community(req, res) { return handleApi(req, res, '/api/community'); }
