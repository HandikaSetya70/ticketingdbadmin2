// /api/admin/blockchain-tickets.js
// Get blockchain tickets with filtering and pagination

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  console.log('🎫 ============ BLOCKCHAIN TICKETS REQUEST ============');
  console.log('⏰ Timestamp:', new Date().toISOString());
  
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
    // Verify admin authentication
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Authorization token required' 
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Invalid authentication token' 
      });
    }

    // Look up admin's user_id in the users table
    const { data: adminUser, error: adminError } = await supabase
      .from('users')
      .select('user_id, id_name, role')
      .eq('auth_id', user.id)
      .single();

    if (adminError || !adminUser) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Admin user not found' 
      });
    }

    if (adminUser.role !== 'admin' && adminUser.role !== 'super_admin') {
      return res.status(403).json({ 
        status: 'error', 
        message: 'Admin privileges required' 
      });
    }

    console.log('✅ Admin authentication verified:', adminUser.id_name);

    // Parse query parameters
    const {
      page = 1,
      limit = 20,
      status = '',           // registered, revoked, pending, failed
      token_search = ''      // search by token ID
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    console.log('📋 Query parameters:');
    console.log('   📄 Page:', pageNum);
    console.log('   📊 Limit:', limitNum);
    console.log('   🔍 Status filter:', status || 'none');
    console.log('   🔢 Token search:', token_search || 'none');

    // Build base query
    let query = supabase
      .from('tickets')
      .select(`
        ticket_id,
        nft_token_id,
        ticket_status,
        blockchain_registered,
        nft_mint_status,
        blockchain_tx_hash,
        blockchain_sync_status,
        last_blockchain_sync,
        purchase_date,
        ticket_number,
        users!inner(id_name, id_number),
        events!inner(event_name, event_date, venue)
      `, { count: 'exact' })
      .not('nft_token_id', 'is', null) // Only tickets with blockchain token IDs
      .order('purchase_date', { ascending: false });

    // Apply status filter
    if (status) {
      switch (status) {
        case 'registered':
          query = query.eq('blockchain_registered', true).eq('ticket_status', 'valid');
          break;
        case 'revoked':
          query = query.eq('ticket_status', 'revoked');
          break;
        case 'pending':
          query = query.eq('blockchain_registered', false);
          break;
        case 'failed':
          query = query.eq('nft_mint_status', 'failed');
          break;
      }
    }

    // Apply token search filter
    if (token_search) {
      query = query.ilike('nft_token_id', `%${token_search}%`);
    }

    // Apply pagination
    query = query.range(offset, offset + limitNum - 1);

    console.log('🔍 Executing database query...');
    const { data: tickets, error: ticketsError, count } = await query;

    if (ticketsError) {
      console.error('❌ Database query failed:', ticketsError);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch blockchain tickets',
        error: ticketsError.message
      });
    }

    console.log(`✅ Found ${tickets?.length || 0} tickets (total: ${count || 0})`);

    // Calculate pagination info
    const totalPages = Math.ceil((count || 0) / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    const pagination = {
      page: pageNum,
      limit: limitNum,
      total: count || 0,
      totalPages: totalPages,
      hasNextPage: hasNextPage,
      hasPrevPage: hasPrevPage
    };

    console.log('📊 Pagination info:');
    console.log('   📄 Current page:', pagination.page);
    console.log('   📊 Total pages:', pagination.totalPages);
    console.log('   🔢 Total tickets:', pagination.total);

    return res.status(200).json({
      status: 'success',
      message: `Retrieved ${tickets?.length || 0} blockchain tickets`,
      data: {
        tickets: tickets || [],
        pagination: pagination
      }
    });

  } catch (error) {
    console.error('❌ Error in blockchain tickets endpoint:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      error: error.message
    });
  }
}