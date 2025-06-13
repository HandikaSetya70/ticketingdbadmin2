import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle OPTIONS preflight request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ 
            status: 'error', 
            message: 'Method not allowed' 
        });
    }

    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ 
                status: 'error', 
                message: 'Authorization token required' 
            });
        }

        const { 
            page = 1, 
            limit = 50, 
            event_id, 
            user_id, 
            status,
            flag
        } = req.query;

        console.log('📚 ============ FETCHING PURCHASE HISTORY ============');
        console.log('📄 Page:', page, 'Limit:', limit);
        console.log('🎭 Event filter:', event_id || 'All');
        console.log('👤 User filter:', user_id || 'All');
        console.log('📊 Status filter:', status || 'All');
        console.log('🏷️ Flag filter:', flag || 'All');

        let query = supabase
            .from('purchase_history')
            .select(`
                *,
                users!inner(user_id, id_name, id_number, verification_status),
                events!inner(event_id, event_name, event_date, venue),
                payments!inner(payment_id, amount, payment_status)
            `);

        // Apply filters
        if (event_id) query = query.eq('event_id', event_id);
        if (user_id) query = query.eq('user_id', user_id);
        if (status) query = query.eq('status', status);
        if (flag) query = query.eq('flag', flag);

        // Get total count for pagination
        const { count } = await query;

        // Pagination
        const from = (page - 1) * limit;
        const to = from + parseInt(limit) - 1;

        const { data: purchases, error } = await query
            .range(from, to)
            .order('purchase_timestamp', { ascending: false });

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ 
                status: 'error', 
                message: 'Failed to retrieve purchase history',
                error: error.message
            });
        }

        console.log(`✅ Retrieved ${purchases?.length || 0} purchase records`);

        return res.status(200).json({
            status: 'success',
            message: 'Purchase history retrieved successfully',
            data: {
                purchases: purchases || [],
                pagination: {
                    total: count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(count / limit),
                    hasNextPage: (page * limit) < count,
                    hasPrevPage: page > 1
                },
                summary: {
                    total_records: count,
                    current_page_count: purchases?.length || 0
                }
            }
        });

    } catch (error) {
        console.error('Error retrieving purchase history:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Internal server error',
            error: error.message
        });
    }
}