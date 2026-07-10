export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bank_accounts: {
        Row: {
          account_number: string | null
          active: boolean
          agency: string | null
          bank: string
          created_at: string
          created_by: string | null
          entity_name: string
          id: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          account_number?: string | null
          active?: boolean
          agency?: string | null
          bank: string
          created_at?: string
          created_by?: string | null
          entity_name: string
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          account_number?: string | null
          active?: boolean
          agency?: string | null
          bank?: string
          created_at?: string
          created_by?: string | null
          entity_name?: string
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      daily_account_status: {
        Row: {
          account_id: string
          created_at: string
          created_by: string | null
          date: string
          id: string
          no_movement_reason: string | null
          status: Database["public"]["Enums"]["daily_status"]
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          created_by?: string | null
          date?: string
          id?: string
          no_movement_reason?: string | null
          status?: Database["public"]["Enums"]["daily_status"]
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          created_by?: string | null
          date?: string
          id?: string
          no_movement_reason?: string | null
          status?: Database["public"]["Enums"]["daily_status"]
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      reconciliation_audit_log: {
        Row: {
          action: string
          created_at: string
          details: Json | null
          id: string
          reconciliation_id: string
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json | null
          id?: string
          reconciliation_id: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json | null
          id?: string
          reconciliation_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_audit_log_reconciliation_id_fkey"
            columns: ["reconciliation_id"]
            isOneToOne: false
            referencedRelation: "reconciliations"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_entries: {
        Row: {
          amount: number
          beneficiary: string | null
          created_at: string
          description: string | null
          document_ref: string | null
          entry_date: string | null
          entry_type: Database["public"]["Enums"]["entry_type"]
          id: string
          raw: Json | null
          reconciliation_id: string
          source: Database["public"]["Enums"]["entry_source"]
        }
        Insert: {
          amount: number
          beneficiary?: string | null
          created_at?: string
          description?: string | null
          document_ref?: string | null
          entry_date?: string | null
          entry_type: Database["public"]["Enums"]["entry_type"]
          id?: string
          raw?: Json | null
          reconciliation_id: string
          source: Database["public"]["Enums"]["entry_source"]
        }
        Update: {
          amount?: number
          beneficiary?: string | null
          created_at?: string
          description?: string | null
          document_ref?: string | null
          entry_date?: string | null
          entry_type?: Database["public"]["Enums"]["entry_type"]
          id?: string
          raw?: Json | null
          reconciliation_id?: string
          source?: Database["public"]["Enums"]["entry_source"]
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_entries_reconciliation_id_fkey"
            columns: ["reconciliation_id"]
            isOneToOne: false
            referencedRelation: "reconciliations"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_matches: {
        Row: {
          agrotis_entry_id: string | null
          bb_entry_id: string | null
          confidence: Database["public"]["Enums"]["match_confidence"]
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          group_id: string | null
          id: string
          justification: string | null
          reason: string | null
          reconciliation_id: string
          status: Database["public"]["Enums"]["match_status"]
        }
        Insert: {
          agrotis_entry_id?: string | null
          bb_entry_id?: string | null
          confidence: Database["public"]["Enums"]["match_confidence"]
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          group_id?: string | null
          id?: string
          justification?: string | null
          reason?: string | null
          reconciliation_id: string
          status?: Database["public"]["Enums"]["match_status"]
        }
        Update: {
          agrotis_entry_id?: string | null
          bb_entry_id?: string | null
          confidence?: Database["public"]["Enums"]["match_confidence"]
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          group_id?: string | null
          id?: string
          justification?: string | null
          reason?: string | null
          reconciliation_id?: string
          status?: Database["public"]["Enums"]["match_status"]
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_matches_agrotis_entry_id_fkey"
            columns: ["agrotis_entry_id"]
            isOneToOne: false
            referencedRelation: "reconciliation_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_matches_bb_entry_id_fkey"
            columns: ["bb_entry_id"]
            isOneToOne: false
            referencedRelation: "reconciliation_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_matches_reconciliation_id_fkey"
            columns: ["reconciliation_id"]
            isOneToOne: false
            referencedRelation: "reconciliations"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliations: {
        Row: {
          account: string
          agrotis_file_name: string | null
          balance_agrotis_calculated: number | null
          balance_agrotis_previous: number | null
          balance_bank: number | null
          bank_account_id: string | null
          bb_file_name: string | null
          closed_at: string | null
          closed_by: string | null
          closed_with_pending: boolean
          created_at: string
          created_by: string
          id: string
          reconciliation_date: string
          reopened_at: string | null
          reopened_by: string | null
          status: Database["public"]["Enums"]["reconciliation_status"]
          updated_at: string
        }
        Insert: {
          account?: string
          agrotis_file_name?: string | null
          balance_agrotis_calculated?: number | null
          balance_agrotis_previous?: number | null
          balance_bank?: number | null
          bank_account_id?: string | null
          bb_file_name?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closed_with_pending?: boolean
          created_at?: string
          created_by: string
          id?: string
          reconciliation_date?: string
          reopened_at?: string | null
          reopened_by?: string | null
          status?: Database["public"]["Enums"]["reconciliation_status"]
          updated_at?: string
        }
        Update: {
          account?: string
          agrotis_file_name?: string | null
          balance_agrotis_calculated?: number | null
          balance_agrotis_previous?: number | null
          balance_bank?: number | null
          bank_account_id?: string | null
          bb_file_name?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closed_with_pending?: boolean
          created_at?: string
          created_by?: string
          id?: string
          reconciliation_date?: string
          reopened_at?: string | null
          reopened_by?: string | null
          status?: Database["public"]["Enums"]["reconciliation_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reconciliations_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "dani" | "diretor"
      daily_status: "pendente" | "em_andamento" | "conciliada" | "sem_movimento" | "adiada"
      entry_source: "bb" | "agrotis"
      entry_type: "C" | "D"
      match_confidence: "strong" | "medium" | "pending"
      match_status: "suggested" | "confirmed" | "manual" | "no_pair"
      reconciliation_status: "aberta" | "fechada" | "reaberta"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["dani", "diretor"],
      daily_status: ["pendente", "em_andamento", "conciliada", "sem_movimento", "adiada"],
      entry_source: ["bb", "agrotis"],
      entry_type: ["C", "D"],
      match_confidence: ["strong", "medium", "pending"],
      match_status: ["suggested", "confirmed", "manual", "no_pair"],
      reconciliation_status: ["aberta", "fechada", "reaberta"],
    },
  },
} as const
