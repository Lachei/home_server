#include "Database.hpp"
#include <filesystem>
#include <fstream>
#include <sstream>

#include "util.hpp"

using src_loc = std::source_location;

Database::Table::Table(std::string_view storage_location, const std::optional<ColumnInfos>& column_infos):
    storage_location(std::string(storage_location))
{
    auto file_parent_path = std::filesystem::path(storage_location).parent_path();
    if(!std::filesystem::exists(file_parent_path))
        std::filesystem::create_directory(file_parent_path);

    // loading from file --------------------------------------------------------
    std::ifstream data_file(this->storage_location, std::ios_base::binary);
    if (data_file) {
        GeneralHeader general_header{};
        data_file.read(reinterpret_cast<char*>(&general_header), sizeof(general_header));
        if (general_header.magic_num != DBTABLEMAGICNUM)
            throw std::runtime_error{log_msg("Magic number for header mismatch")};
        
        // parse into the correct special header
        if (general_header.type == detail::columnar_header_id) {
            HeaderDataColumnar header{};
            data_file.read(reinterpret_cast<char*>(&header), sizeof(header));

            // getting the column infos
            this->column_infos.id_column = header.id_column;
            std::string column_names; column_names.resize(header.column_names_len);
            data_file.seekg(header.column_names_offset, data_file.beg).read(column_names.data(), header.column_names_len);
            std::stringstream column_names_stream(column_names);
            this->column_infos.column_names.resize(header.num_columns);
            for(uint32_t i: i_range(header.column_names_len))
                column_names_stream >> this->column_infos.column_names[i];
            
            this->column_infos.column_type_ids.resize(header.num_columns);
            data_file.seekg(header.column_types_offset, data_file.beg).read(reinterpret_cast<char*>(this->column_infos.column_type_ids.data()), header.num_columns * sizeof(uint32_t));
            
            if (column_infos && *column_infos != this->column_infos)
                throw std::runtime_error{log_msg("Column mismatch for stored table and requested table format")};
            

        }
        else
            throw std::runtime_error{log_msg("Unknown header type")};
    }
    
    // if reaching here, hte file does not exist
    if (column_infos->column_names.size() != column_infos->column_type_ids.size())
        throw std::runtime_error{log_msg("The column infos given have different length for names and type_ids.")};
    this->column_infos = *column_infos;
    this->loaded_data.resize(this->column_infos.column_names.size());
    //std::ofstream new_file(this->storage_location);
}

Database::Database(std::string_view storage_location){

}