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
            ticket_status, // 'valid', 'revoked'
            event_id, 
            user_id,
            search, // Search by user name or ticket ID
            sort_by = 'purchase_date', // 'purchase_date', 'ticket_number', 'event_name'
            sort_order = 'desc' // 'asc', 'desc'
        } = req.query;

        console.log('🎫 ============ FETCHING ALL TICKETS ============');
        console.log('📄 Page:', page, 'Limit:', limit);
        console.log('📊 Status filter:', ticket_status || 'All');
        console.log('🎭 Event filter:', event_id || 'All');
        console.log('👤 User filter:', user_id || 'All');
        console.log('🔍 Search term:', search || 'None');
        console.log('📈 Sort:', sort_by, sort_order);

        // Build base query with ONLY existing columns from your schema
        let query = supabase
            .from('tickets')
            .select(`
                ticket_id,
                user_id,
                event_id,
                payment_id,
                purchase_date,
                ticket_status,
                blockchain_ticket_id,
                qr_code_hash,
                qr_code_data,
                qr_code_base64,
                ticket_number,
                total_tickets_in_group,
                is_parent_ticket,
                parent_ticket_id,
                nft_contract_address,
                nft_token_id,
                nft_mint_status,
                nft_metadata,
                blockchain_registered,
                blockchain_tx_hash,
                blockchain_error,
                users!inner(
                    user_id, 
                    id_name, 
                    id_number, 
                    verification_status,
                    role
                ),
                events!inner(
                    event_id, 
                    event_name, 
                    event_date, 
                    venue,
                    ticket_price
                ),
                payments!inner(
                    payment_id, 
                    amount, 
                    payment_status,
                    paypal_order_id,
                    paypal_transaction_id
                )
            `);

        // Apply filters
        if (ticket_status) {
            query = query.eq('ticket_status', ticket_status);
        }
        
        if (event_id) {
            query = query.eq('event_id', event_id);
        }
        
        if (user_id) {
            query = query.eq('user_id', user_id);
        }

        // Apply search filter (simplified for now - full-text search would be better)
        if (search) {
            query = query.or(`
                ticket_id.ilike.%${search}%,
                blockchain_ticket_id.ilike.%${search}%
            `);
        }

        // Get total count for pagination (before applying range)
        const { count } = await query;

        // Apply sorting
        let orderBy = 'purchase_date';
        let ascending = sort_order === 'asc';
        
        switch (sort_by) {
            case 'ticket_number':
                orderBy = 'ticket_number';
                break;
            case 'ticket_status':
                orderBy = 'ticket_status';
                break;
            case 'purchase_date':
            default:
                orderBy = 'purchase_date';
        }

        // Apply pagination and execute query
        const from = (page - 1) * limit;
        const to = from + parseInt(limit) - 1;

        const { data: tickets, error } = await query
            .range(from, to)
            .order(orderBy, { ascending });

        if (error) {
            console.error('❌ Database error:', error);
            return res.status(500).json({ 
                status: 'error', 
                message: 'Failed to retrieve tickets',
                error: error.message
            });
        }

        // Calculate summary statistics manually
        console.log('📊 Calculating ticket statistics...');
        
        const { data: allTicketsCount } = await supabase
            .from('tickets')
            .select('ticket_status, nft_mint_status, blockchain_registered', { count: 'exact' });

        const summary = {
            total_tickets: allTicketsCount?.length || 0,
            valid_tickets: allTicketsCount?.filter(t => t.ticket_status === 'valid').length || 0,
            revoked_tickets: allTicketsCount?.filter(t => t.ticket_status === 'revoked').length || 0,
            blockchain_registered: allTicketsCount?.filter(t => t.blockchain_registered === true).length || 0,
            nft_minted: allTicketsCount?.filter(t => t.nft_mint_status === 'minted').length || 0,
            nft_pending: allTicketsCount?.filter(t => t.nft_mint_status === 'pending').length || 0,
            nft_failed: allTicketsCount?.filter(t => t.nft_mint_status === 'failed').length || 0
        };

        console.log(`✅ Retrieved ${tickets?.length || 0} tickets`);
        console.log('📊 Summary:', summary);

        return res.status(200).json({
            status: 'success',
            message: 'Tickets retrieved successfully',
            data: {
                tickets: tickets || [],
                pagination: {
                    total: count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(count / limit),
                    hasNextPage: (page * limit) < count,
                    hasPrevPage: page > 1
                },
                summary: summary,
                filters_applied: {
                    ticket_status: ticket_status || null,
                    event_id: event_id || null,
                    user_id: user_id || null,
                    search: search || null,
                    sort_by: sort_by,
                    sort_order: sort_order
                }
            }
        });

    } catch (error) {
        console.error('❌ Error retrieving tickets:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Internal server error',
            error: error.message
        });
    }
}