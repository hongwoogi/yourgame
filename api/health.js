import { handleApi } from '../server/app.mjs';
export default (req, res) => handleApi(req, res, '/api/health');
