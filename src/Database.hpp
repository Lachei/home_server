#pragma once

#include <string_view>
#include <string>
#include <variant>
#include <vector>
#include <array>
#include <chrono>
#include <inttypes.h>
#include <memory>
#include <unordered_map>

#include "nlohmann/json.hpp"
#include "Bitset.hpp"
#include "robin_hood/robin_hood.h"

constexpr uint64_t DBTABLEMAGICNUM = 0x409ca93b33af;
constexpr uint32_t DBTABLEKINDSTRINGLEN = 4;

// Class to store all kinds of tabular data, data is stored in column major format
class Database{
public:
    using Date = std::chrono::system_clock::time_point;
    using ColumnType = std::variant<std::vector<float>, 
                                    std::vector<double>,
                                    std::vector<int32_t>, 
                                    std::vector<int64_t>, 
                                    std::vector<uint32_t>, 
                                    std::vector<uint64_t>, 
                                    std::vector<std::string>, 
                                    std::vector<Date>, 
                                    std::vector<std::vector<std::byte>>>;
    struct Table{
        // there might be more header datas coming, currently only columnar is available
        struct GeneralHeader{
            uint64_t magic_num;
            std::array<char, DBTABLEKINDSTRINGLEN> type;
        };
        static constexpr std::array<char, DBTABLEKINDSTRINGLEN> columnar_header_id{'c','o','l','1'};
        struct HeaderDataColumnar{
            // The data layout is the following (number after colon is the byte offset)
            // GeneralHeader: 0,
            // HeaderDataColumnar: sizeof(GeneralHeader),
            // ColumnNames: column_names_offset
            // ColumnTypes: column_types_offset
            // ColumnOffsetsLengths: columns_offset_lengths_offset (for each column one offset + length exists here)
            // Columns
            uint32_t num_columns;
            uint64_t num_rows;
            uint32_t id_column;
            uint32_t column_names_offset;
            uint32_t column_names_len;
            uint32_t column_types_offset;
            uint32_t columns_offsets_lengths;
        };
        template<typename T> static constexpr size_t type_id() {constexpr ColumnType t{std::vector<T>{}}; return t.index();}
        std::string storage_location{};
        std::vector<ColumnType> loaded_data{};  // this is only the data cache, might be missing part of the data in the file
        uint64_t loaded_data_offset{};
        struct ColumnInfos{
            std::vector<std::string> column_names{};
            uint id_column{};
            
            bool operator<=>(const ColumnInfos&) const = default;
            uint32_t num_columns() const {return column_names.size();}
        } column_infos{};
        
        // If column_infos is empty, the table layout is loaded from the stored data.
        // If no column_infos is given and the file does not exist on the computer an error will be thrown
        Table(std::string_view storage_location, const std::optional<ColumnInfos>& column_infos = {});
        ~Table() {store_cache();}
        
        void store_cache() const;
        size_t num_rows() const { if (loaded_data.empty()) return size_t{}; return std::visit([](auto&& v){return v.size();}, loaded_data[0]);}

        void insert_row(const nlohmann::json& element);
        // same as insert_row but requires the elements to be an array or a set of valid element objects
        void insert_rows(const nlohmann::json& elements);
        
        // filter_args must have the following structure: {column_name, check_operation}
        Bitset get_active_bitset(const nlohmann::json& filter_args);
        nlohmann::json get_elements(const Bitset& filter_args);
        nlohmann::json get_elements(const nlohmann::json& filter_args);
    };
    
    Database(std::string_view storage_location);
    ~Database() { store_table_caches(); }

    void store_table_caches() const; 
private:
    std::string _storage_location;
    robin_hood::unordered_map<std::string, std::unique_ptr<Table>> _tables;
};
