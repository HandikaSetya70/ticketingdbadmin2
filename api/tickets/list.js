import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'http://setya.fwh.is');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ 
      status: 'error', 
      message: 'Method not allowed' 
    })
  }

  try {
    // Get the authorization header
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        status: 'error',
        message: 'Missing or invalid authorization header'
      })
    }

    const token = authHeader.split(' ')[1]
    
    // Verify the token and get user details
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid or expired token'
      })
    }

    // Check if the user has admin role
    const { data: adminUser, error: adminError } = await supabase
      .from('users')
      .select('role')
      .eq('auth_id', user.id)
      .single()

    if (adminError || !adminUser || !['admin', 'super_admin'].includes(adminUser.role)) {
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized. Admin access required.'
      })
    }

    // Get query parameters for filtering and pagination
    const { 
      status, 
      event_id,
      user_id,
      sort = 'created_at', 
      order = 'desc',
      page = 1,
      limit = 50
    } = req.query

    // Calculate offset for pagination
    const offset = (parseInt(page) - 1) * parseInt(limit)

    // Build query to get tickets with joins for user and event data
    let query = supabase
      .from('tickets')
      .select(`
        *,
        users (
          user_id,
          id_name,
          id_number
        ),
        events (
          event_id,
          event_name,
          event_date,
          venue
        )
      `, { count: 'exact' })

    // Apply filters
    if (status) {
      query = query.eq('ticket_status', status)
    }
    if (event_id) {
      query = query.eq('event_id', event_id)
    }
    if (user_id) {
      query = query.eq('user_id', user_id)
    }

    // Apply sorting
    query = query.order(sort, { ascending: order === 'asc' })

    // Apply pagination
    query = query.range(offset, offset + parseInt(limit) - 1)

    // Execute query
    const { data: tickets, error: ticketsError, count } = await query

    if (ticketsError) {
      throw ticketsError
    }

    // Format ticket data for response
    const formattedTickets = tickets.map(ticket => ({
      ticket_id: ticket.ticket_id,
      blockchain_ticket_id: ticket.blockchain_ticket_id,
      user_id: ticket.user_id,
      user_name: ticket.users?.id_name || 'Unknown',
      user_id_number: ticket.users?.id_number || 'Unknown',
      event_id: ticket.event_id,
      event_name: ticket.events?.event_name || 'Unknown',
      event_date: ticket.events?.event_date,
      venue: ticket.events?.venue,
      ticket_status: ticket.ticket_status,
      ticket_number: ticket.ticket_number,
      total_tickets_in_group: ticket.total_tickets_in_group,
      is_parent_ticket: ticket.is_parent_ticket,
      parent_ticket_id: ticket.parent_ticket_id,
      payment_id: ticket.payment_id,
      purchase_date: ticket.purchase_date || ticket.created_at,
      qr_code_hash: ticket.qr_code_hash
    }))

    // Calculate pagination info
    const totalPages = Math.ceil(count / parseInt(limit))
    const hasNextPage = parseInt(page) < totalPages
    const hasPrevPage = parseInt(page) > 1

    return res.status(200).json({
      status: 'success',
      message: 'Tickets retrieved successfully',
      data: {
        tickets: formattedTickets,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages,
          hasNextPage,
          hasPrevPage
        }
      }
    })

  } catch (error) {
    console.error('Error fetching tickets:', error)
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred while fetching tickets',
      error: error.message
    })
  }
}