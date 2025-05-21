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
      .select('role, user_id')
      .eq('auth_id', user.id)
      .single()

    if (adminError || !adminUser || !['admin', 'super_admin'].includes(adminUser.role)) {
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized. Admin access required.'
      })
    }

    // Get the request data
    const { ticket_id, reason } = req.body

    // Validate required fields
    if (!ticket_id || !reason) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: ticket_id, reason'
      })
    }

    // Check if ticket exists
    const { data: ticket, error: ticketError } = await supabase
      .from('tickets')
      .select('*')
      .eq('ticket_id', ticket_id)
      .single()

    if (ticketError || !ticket) {
      return res.status(404).json({
        status: 'error',
        message: 'Ticket not found'
      })
    }

    // Check if ticket is already revoked
    if (ticket.ticket_status === 'revoked') {
      return res.status(409).json({
        status: 'error',
        message: 'Ticket is already revoked'
      })
    }

    // Start database transaction (we'll use supabase functions one after another)
    
    // 1. Update ticket status
    const { data: updatedTicket, error: updateError } = await supabase
      .from('tickets')
      .update({ ticket_status: 'revoked' })
      .eq('ticket_id', ticket_id)
      .select()
      .single()

    if (updateError) {
      throw updateError
    }

    // 2. Create revocation log entry with enhanced fields
    const blockchainStatus = (ticket.nft_contract_address && ticket.nft_token_id) ? 'pending' : 'not_applicable';
    
    const { data: logEntry, error: logError } = await supabase
      .from('revocation_log')
      .insert([{
        ticket_id,
        admin_id: adminUser.user_id,
        reason,
        blockchain_status: blockchainStatus,
        blockchain_tx_hash: null,
        revocation_proof: null
      }])
      .select()
      .single()

    if (logError) {
      console.error('Error creating revocation log:', logError)
      // Don't throw error here as the ticket was already revoked
    }

    // 3. If ticket has blockchain info, add to blockchain revocation queue
    let queueEntry = null;
    if (blockchainStatus === 'pending' && logEntry) {
      const { data: queueData, error: queueError } = await supabase
        .from('blockchain_revocation_queue')
        .insert([{
          ticket_id,
          revocation_log_id: logEntry.id,
          status: 'pending'
        }])
        .select()
        .single()

      if (queueError) {
        console.error('Error adding to blockchain queue:', queueError)
        // Don't throw error here as the database revocation worked
      } else {
        queueEntry = queueData;
      }
    }

    // Determine if we need to handle revocation of related tickets
    let groupTickets = [];
    if (ticket.is_parent_ticket && ticket.total_tickets_in_group > 1) {
      // This is a parent ticket, revoke all child tickets
      const { data: childTickets, error: childError } = await supabase
        .from('tickets')
        .select('ticket_id')
        .eq('parent_ticket_id', ticket_id)
        .eq('ticket_status', 'valid')
      
      if (!childError && childTickets && childTickets.length > 0) {
        // Update all child tickets
        const { data: updatedChildren, error: updateChildrenError } = await supabase
          .from('tickets')
          .update({ ticket_status: 'revoked' })
          .in('ticket_id', childTickets.map(t => t.ticket_id))
          .select()
        
        if (!updateChildrenError) {
          groupTickets = updatedChildren;
          
          // Log revocation for each child ticket
          const childLogEntries = childTickets.map(childTicket => ({
            ticket_id: childTicket.ticket_id,
            admin_id: adminUser.user_id,
            reason: `Revoked as part of group. Parent ticket ${ticket_id} was revoked. Reason: ${reason}`,
            blockchain_status: 'not_applicable'
          }));
          
          const { data: childLogs, error: childLogError } = await supabase
            .from('revocation_log')
            .insert(childLogEntries)
            .select();
            
          if (childLogError) {
            console.error('Error logging child revocations:', childLogError);
          }
        }
      }
    } else if (ticket.parent_ticket_id) {
      // This is a child ticket, we might want to update the parent to reflect the status change
      // For now, we won't automatically revoke the parent, but we could add that logic here
    }

    return res.status(200).json({
      status: 'success',
      message: 'Ticket revoked successfully',
      data: {
        ticket: updatedTicket,
        revocation_log: logEntry,
        blockchain_status: blockchainStatus,
        blockchain_queue: queueEntry,
        group_tickets: groupTickets.length > 0 ? {
          count: groupTickets.length,
          revoked: groupTickets.length
        } : null
      }
    })

  } catch (error) {
    console.error('Error revoking ticket:', error)
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred while revoking the ticket',
      error: error.message
    })
  }
}