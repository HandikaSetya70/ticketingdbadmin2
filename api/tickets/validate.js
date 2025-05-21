import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*'); // Use '*' during testing, later restrict to your domain
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
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
    
    // Verify the admin token and get user details
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

    // Get the request data
    const { ticket_id, user_id, qr_code_hash } = req.body

    // Validate required fields - allow either ticket_id or qr_code_hash
    if ((!ticket_id && !qr_code_hash) || !user_id) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: either ticket_id or qr_code_hash, and user_id are required'
      })
    }

    // Find the ticket using either ticket_id or qr_code_hash
    let ticketQuery = supabase
      .from('tickets')
      .select(`
        *,
        events (
          event_id,
          event_name,
          event_date,
          venue,
          nft_contract_address,
          blockchain_network
        )
      `);
    
    if (ticket_id) {
      ticketQuery = ticketQuery.eq('ticket_id', ticket_id);
    } else {
      ticketQuery = ticketQuery.eq('qr_code_hash', qr_code_hash);
    }
    
    const { data: ticket, error: ticketError } = await ticketQuery.single();

    if (ticketError || !ticket) {
      return res.status(404).json({
        status: 'error',
        message: 'Ticket not found'
      })
    }

    // Check if ticket belongs to the user
    if (ticket.user_id !== user_id) {
      return res.status(403).json({
        status: 'error',
        message: 'Ticket does not belong to this user'
      })
    }

    // Check ticket revocation status
    if (ticket.ticket_status === 'revoked') {
      // Get revocation details
      const { data: revocation, error: revocationError } = await supabase
        .from('revocation_log')
        .select(`
          id,
          reason,
          revoked_at,
          blockchain_status,
          blockchain_tx_hash,
          admin:admin_id (
            user_id,
            id_name,
            role
          )
        `)
        .eq('ticket_id', ticket.ticket_id)
        .order('revoked_at', { ascending: false })
        .limit(1)
        .single();

      return res.status(403).json({
        status: 'error',
        message: 'Ticket has been revoked',
        data: {
          ticket_id: ticket.ticket_id,
          status: ticket.ticket_status,
          revocation_details: revocationError ? null : {
            reason: revocation.reason,
            revoked_at: revocation.revoked_at,
            revoked_by: revocation.admin ? revocation.admin.id_name : 'Unknown',
            blockchain_status: revocation.blockchain_status,
            blockchain_tx_hash: revocation.blockchain_tx_hash
          }
        }
      })
    }

    // Enhanced validation for NFT tickets
    let blockchainStatus = 'not_applicable';
    
    if (ticket.nft_contract_address && ticket.nft_token_id) {
      // In a complete implementation, we would check the blockchain here
      // For now, we'll just report it as 'valid_on_database'
      blockchainStatus = 'valid_on_database';
      
      // Check if there's a pending blockchain revocation
      const { data: pendingRevocation, error: pendingError } = await supabase
        .from('blockchain_revocation_queue')
        .select('*')
        .eq('ticket_id', ticket.ticket_id)
        .eq('status', 'pending')
        .limit(1);
        
      if (!pendingError && pendingRevocation && pendingRevocation.length > 0) {
        blockchainStatus = 'pending_blockchain_revocation';
      }
      
      // Here you would add actual blockchain verification
      // const isRevokedOnChain = await checkBlockchainRevocationStatus(
      //   ticket.nft_contract_address, 
      //   ticket.nft_token_id,
      //   ticket.events.blockchain_network
      // );
      // 
      // if (isRevokedOnChain) {
      //   blockchainStatus = 'revoked_on_chain';
      //   // Update our database to match chain status
      //   await syncRevocationFromBlockchain(ticket);
      //   return res.status(403).json({...});
      // }
    }

    // If ticket is part of a group, get group status
    let groupStatus = null
    if (ticket.is_parent_ticket || ticket.parent_ticket_id) {
      const parentId = ticket.is_parent_ticket ? ticket.ticket_id : ticket.parent_ticket_id
      
      const { data: groupTickets, error: groupError } = await supabase
        .from('tickets')
        .select('ticket_status')
        .or(`ticket_id.eq.${parentId},parent_ticket_id.eq.${parentId}`)

      if (!groupError && groupTickets) {
        groupStatus = {
          total_tickets: groupTickets.length,
          valid_tickets: groupTickets.filter(t => t.ticket_status === 'valid').length,
          revoked_tickets: groupTickets.filter(t => t.ticket_status === 'revoked').length
        }
      }
    }

    // Log this validation check for audit purposes
    // This is optional but helpful for tracking ticket usage
    const { error: validationLogError } = await supabase
      .from('ticket_validation_log')
      .insert([{
        ticket_id: ticket.ticket_id,
        admin_id: adminUser.user_id,
        validation_status: 'valid',
        validation_method: ticket_id ? 'ticket_id' : 'qr_code'
      }])
      .select();
      
    if (validationLogError) {
      console.error('Error logging validation:', validationLogError);
      // Continue anyway, this is just for auditing
    }

    return res.status(200).json({
      status: 'success',
      message: 'Ticket is valid',
      data: {
        ticket_id: ticket.ticket_id,
        blockchain_ticket_id: ticket.blockchain_ticket_id,
        event_name: ticket.events?.event_name,
        event_date: ticket.events?.event_date,
        venue: ticket.events?.venue,
        status: ticket.ticket_status,
        qr_code_hash: ticket.qr_code_hash,
        ticket_number: ticket.ticket_number,
        total_tickets_in_group: ticket.total_tickets_in_group,
        blockchain_status: blockchainStatus,
        group_status: groupStatus,
        nft_details: ticket.nft_contract_address ? {
          contract_address: ticket.nft_contract_address,
          token_id: ticket.nft_token_id,
          network: ticket.events?.blockchain_network || 'sepolia'
        } : null
      }
    })

  } catch (error) {
    console.error('Error validating ticket:', error)
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred while validating the ticket',
      error: error.message
    })
  }
}